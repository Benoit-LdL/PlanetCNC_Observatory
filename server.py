#!/usr/bin/env python3
"""PlanetCNC Observatory - server.

Receives machine state and the loaded G-code program from the bridge script
running inside PlanetCNC TNG (bridge/planetcnc_bridge.py) and serves a live
web dashboard to any browser.

Standard library only - no pip install required.

    python server.py                      # listen on 0.0.0.0:8080
    python server.py --port 8090 --token secret
    python server.py --demo               # simulated machine, no PlanetCNC needed

Camera: a USB webcam is streamed to the dashboard through ffmpeg
(`sudo apt install ffmpeg`). By default /dev/video0 is used if it exists;
ffmpeg only runs while someone is watching. The picture is also reachable on
its own, without the dashboard: /camera (a full-window page), /api/camera.mjpg
(the MJPEG stream) and /api/camera.jpg (one still picture).

    python server.py --camera /dev/video1 --camera-size 1280x720 --camera-fps 15
    python server.py --camera none        # disable the camera panel
    python server.py --camera-cmd "rpicam-vid -t 0 -n --codec mjpeg -o -"   # any MJPEG-on-stdout source
"""

import argparse
import base64
import bisect
import hashlib
import hmac
import json
import logging
import logging.handlers
import math
import mimetypes
import os
import platform
import queue
import re
import select
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlencode, urlparse

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
BRIDGE_TIMEOUT = 3.0  # seconds without an update before the bridge is reported offline
COMMAND_TTL = 2.0      # a command the bridge hasn't picked up by then is dropped, never run late
COMMAND_WAIT = 10.0    # how long a browser request waits for TNG's answer
ESTOP_PROTOCOL = 3     # first bridge version that accepts the E-stop request
OPEN_PROTOCOL = 4      # first bridge version that can open a program in TNG
GCODE_EXTS = (".nc", ".ngc", ".gcode", ".gc", ".tap", ".cnc", ".txt")  # as the Files tab and the bridge
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
CONSOLE_LINES = 500      # console history kept in memory
JOB_CONFIRM_LINES = 2    # a run is a job (not homing or a jog) once the program line has gone up this much

# ---------------------------------------------------------------------------
# What the (generic) bridge reads from TNG, and how that becomes dashboard state.
# Changing anything here needs no bridge update: the bridge receives this spec.
# ---------------------------------------------------------------------------

TNG_TOOL_DIAMETER_PARAMS = ("_current_tooldiameter", "_current_tool_diameter", "_current_tooldia", "_tool_diameter")

# Each item: [key, kind, name] - kind p = TNG parameter, f = planetcnc function
# without arguments, c = command id (to know whether TNG has that command).
_ITEMS = [
    ["work", "f", "hw_work"], ["machine", "f", "hw_motor"],
    ["x", "p", "_x"], ["y", "p", "_y"], ["z", "p", "_z"],
    ["mx", "p", "_machine_x"], ["my", "p", "_machine_y"], ["mz", "p", "_machine_z"],
    ["linenum", "p", "_hw_linenum"], ["prog_line", "p", "_prog_line"], ["line_count", "p", "_prog_linecnt"],
    ["speed", "f", "hw_speed"], ["speed_p", "p", "_hw_speed"],
    ["spindle", "f", "hw_spindle"], ["spindle_p", "p", "_hw_spindle"],
    ["tool", "p", "_current_tool"], ["tool_name", "p", "_current_toolname"],
] + [
    # Diameter of the loaded tool from TNG's tool table. The parameter name isn't documented
    # anywhere we could check, so a few likely spellings are tried; unknown ones read as nothing.
    ["tool_dia_%d" % i, "p", name] for i, name in enumerate(TNG_TOOL_DIAMETER_PARAMS)
] + [
    ["coordsys", "p", "_coordsys_name"], ["units", "p", "_units"],
    # Fallbacks: with tool changes that TNG doesn't track (e.g. done by hand) _current_tool stays 0
    # while _selected_tool has the program's T word; _coordsys_name can be empty while _coordsys
    # has the number (1 = G54).
    ["tool_sel", "p", "_selected_tool"], ["coordsys_num", "p", "_coordsys"],
    ["run", "p", "_hw_run"], ["pause", "p", "_hw_pause"], ["estop", "p", "_hw_estop"], ["idle", "p", "_hw_idle"],
    ["file", "p", "_prog_file"], ["time_to_end", "p", "_progress_timetoend"],
] + [["lim_%s%s" % (a, d), "p", "_motorlimit_%s%s" % (a, d)] for a in "xyz" for d in "np"]

BRIDGE_SPEC = {
    "items": _ITEMS,
    "program_key": "file",                          # value holding the loaded program's path
}
BRIDGE_SPEC["id"] = hashlib.sha1(json.dumps(BRIDGE_SPEC, sort_keys=True).encode()).hexdigest()[:12]

# planetcnc functions anyone with dashboard access may call through /api/tng/call (reading only)
TNG_READ_PREFIXES = ("hw_", "is_", "get_", "gcode_is_", "cmd_get_", "cmd_is_")
TNG_READ_FUNCS = {"param_get", "cmd_list", "cmd_count", "msg_count", "msg_is_active", "starttime"}

# ---------------------------------------------------------------------------
# Logging: everything worth knowing afterwards goes to logs/server.log (rotated, cleaned
# up automatically) and the important part also to stdout (journalctl).
# ---------------------------------------------------------------------------

LOG_FORMAT = "%(asctime)s.%(msecs)03d %(levelname)-7s %(name)-14s %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
LOG_FILE = "server.log"
LOG_FILE_COUNT = 10            # server.log + 9 older pieces; the size limit is shared between them
LOG_CLEANUP_EVERY = 3600       # seconds between cleanup runs
LOG_MIN_FREE_DISK = 500 * 2**20  # below this much free space, only the current log file is kept
SLOW_REQUEST = 3.0             # requests taking longer than this are logged as warnings
STREAM_WRITE_TIMEOUT = 20.0    # a browser that stops reading a live stream for this long is dropped
BRIDGE_GAP_WARN = 1.5          # bridge updates normally come every 0.2 s
HEARTBEAT_EVERY = 300          # seconds between status lines in the log
CLIENT_LOG_LIMIT = 120         # lines per minute a browser may send to the log

LOG = logging.getLogger("pcnc")
log_http = LOG.getChild("http")
log_bridge = LOG.getChild("bridge")
log_machine = LOG.getChild("machine")
log_camera = LOG.getChild("camera")
log_update = LOG.getChild("update")
log_files = LOG.getChild("files")
log_client = LOG.getChild("browser")
log_system = LOG.getChild("system")
log_notify = LOG.getChild("telegram")
log_mqtt = LOG.getChild("mqtt")


class LogManager:
    """Sets up the log handlers and keeps the log folder within its size and age limits."""

    def __init__(self):
        self.dir = ""
        self.max_bytes = 0
        self.keep_days = 0
        self.file_handler = None
        self.low_disk_reported = False

    def setup(self, log_dir, max_mb, keep_days, debug):
        LOG.setLevel(logging.DEBUG)
        LOG.propagate = False
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.INFO)
        console.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))  # journald adds the time
        LOG.addHandler(console)

        self.max_bytes = max(1, max_mb) * 2**20
        self.keep_days = keep_days
        if log_dir != "none":
            try:
                os.makedirs(log_dir, exist_ok=True)
                handler = logging.handlers.RotatingFileHandler(
                    os.path.join(log_dir, LOG_FILE), maxBytes=self.max_bytes // LOG_FILE_COUNT,
                    backupCount=LOG_FILE_COUNT - 1, encoding="utf-8")
                handler.setFormatter(logging.Formatter(LOG_FORMAT, LOG_DATE_FORMAT))
                LOG.addHandler(handler)
                self.dir, self.file_handler = os.path.abspath(log_dir), handler
            except OSError as e:
                LOG.error("cannot write logs to %s: %s - logging to the console only", log_dir, e)
        self.set_debug(debug)

        # Crashes in any thread end up in the log too, with their traceback.
        threading.excepthook = lambda a: LOG.critical(
            "unexpected error in thread %s", a.thread.name if a.thread else "?",
            exc_info=(a.exc_type, a.exc_value, a.exc_traceback))
        sys.excepthook = lambda t, v, tb: LOG.critical("unexpected error", exc_info=(t, v, tb))
        if self.dir:
            threading.Thread(target=self._cleanup_loop, name="log-cleanup", daemon=True).start()

    def set_debug(self, on):
        if self.file_handler:
            self.file_handler.setLevel(logging.DEBUG if on else logging.INFO)

    def debug_enabled(self):
        return bool(self.file_handler) and self.file_handler.level <= logging.DEBUG

    def files(self):
        """[{name, size, mtime}] of the log folder, newest first."""
        out = []
        if self.dir:
            with os.scandir(self.dir) as it:
                for e in it:
                    if e.is_file():
                        st = e.stat()
                        out.append({"name": e.name, "size": st.st_size, "mtime": st.st_mtime})
        return sorted(out, key=lambda f: -f["mtime"])

    def path(self, name):
        """Full path of a file in the log folder, or None."""
        if not self.dir or not name or name != os.path.basename(name):
            return None
        full = os.path.join(self.dir, name)
        return full if os.path.isfile(full) else None

    def cleanup(self):
        """Delete log files older than keep_days, then the oldest ones while the folder is over
        its size limit or the disk is nearly full. The file being written is never deleted."""
        active = os.path.join(self.dir, LOG_FILE)
        files = [f for f in self.files() if os.path.join(self.dir, f["name"]) != active]
        removed, freed = [], 0
        cutoff = time.time() - self.keep_days * 86400
        total = sum(f["size"] for f in self.files())
        try:
            low_disk = shutil.disk_usage(self.dir).free < LOG_MIN_FREE_DISK
        except OSError:
            low_disk = False
        for f in sorted(files, key=lambda f: f["mtime"]):  # oldest first
            if f["mtime"] < cutoff or total > self.max_bytes or low_disk:
                try:
                    os.remove(os.path.join(self.dir, f["name"]))
                except OSError as e:
                    LOG.warning("log cleanup: cannot delete %s: %s", f["name"], e)
                    continue
                removed.append(f["name"])
                freed += f["size"]
                total -= f["size"]
        if removed:
            LOG.info("log cleanup: deleted %d old file%s (%.1f MB): %s", len(removed), "" if len(removed) == 1 else "s",
                     freed / 2**20, ", ".join(removed))
        if low_disk and not self.low_disk_reported:
            LOG.warning("disk almost full (less than %d MB free) - keeping only the current log file",
                        LOG_MIN_FREE_DISK // 2**20)
        self.low_disk_reported = low_disk

    def _cleanup_loop(self):
        while True:
            try:
                self.cleanup()
            except Exception:
                LOG.exception("log cleanup failed")
            time.sleep(LOG_CLEANUP_EVERY)


LOGS = LogManager()


def short_agent(ua):
    """Browser and OS from a User-Agent, enough to tell devices apart in the log."""
    ua = ua or ""
    browser = next((b for b in ("Edg/", "OPR/", "Firefox/", "Chrome/", "Safari/") if b in ua), "")
    system = next((s for s in ("Android", "iPhone", "iPad", "Windows", "Mac OS", "Linux") if s in ua), "")
    return ("%s %s" % (browser.rstrip("/").replace("Edg", "Edge"), system)).strip() or ua[:40] or "unknown"


class Streams:
    """Counts the open live connections (dashboards and camera viewers) for the log."""

    def __init__(self):
        self.lock = threading.Lock()
        self.open = {"dashboard": 0, "camera": 0}

    def change(self, kind, delta):
        with self.lock:
            self.open[kind] += delta
            return self.open[kind]


STREAMS = Streams()



def _num(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def coordsys_name(n):
    """TNG's coordinate system number -> its G code: 1-6 = G54-G59, 7-9 = G59.1-G59.3."""
    n = int(n)
    if 1 <= n <= 6:
        return "G%d" % (53 + n)
    if 7 <= n <= 9:
        return "G59.%d" % (n - 6)
    return ""


def derive_state(v):
    """Raw values from the bridge -> the state the dashboard shows."""
    def axes(fn_key, param_keys):
        vals = v.get(fn_key)
        if isinstance(vals, list) and vals:
            return [_num(x) for x in vals]
        return [_num(v.get(k)) for k in param_keys]

    line = _num(v.get("linenum"), -1)
    if line < 0:
        line = _num(v.get("prog_line"))
    lo = [_num(v.get("lim_%sn" % a)) for a in "xyz"]
    hi = [_num(v.get("lim_%sp" % a)) for a in "xyz"]
    return {
        "work": axes("work", ("x", "y", "z")),
        "machine": axes("machine", ("mx", "my", "mz")),
        "line": int(line) + CONFIG.line_offset,
        "line_count": int(_num(v.get("line_count"))),
        "feed": _num(v.get("speed")) or _num(v.get("speed_p")),
        "spindle": _num(v.get("spindle")) or _num(v.get("spindle_p")),
        "tool": int(_num(v.get("tool")) or _num(v.get("tool_sel"))),
        "tool_name": str(v.get("tool_name") or ""),
        # First likely tool-table parameter that gives a real diameter; 0 = TNG didn't tell us.
        "tool_diameter": next((d for d in (_num(v.get("tool_dia_%d" % i)) for i in range(len(TNG_TOOL_DIAMETER_PARAMS)))
                               if 0 < d < 1000), 0.0),
        "coordsys": str(v.get("coordsys") or "") or coordsys_name(_num(v.get("coordsys_num"))),
        "units": "in" if _num(v.get("units")) == 20 else "mm",
        "running": bool(_num(v.get("run"))),        # _hw_run: executing the NC program
        "paused": bool(_num(v.get("pause"))),
        "estop": bool(_num(v.get("estop"))),
        "idle": bool(_num(v.get("idle"))),          # _hw_idle: on, connected, not moving
        "file": str(v.get("file") or ""),
        "time_to_end": _num(v.get("time_to_end"), -1),
        "limits": {"min": lo, "max": hi} if all(h > l for l, h in zip(lo, hi)) else None,
    }


class Hub:
    """Holds the latest machine state and program, and wakes SSE listeners on change."""

    def __init__(self):
        self.cond = threading.Condition()
        self.state = {}
        self.state_seq = 0
        self.last_update = 0.0
        self.last_state_time = 0.0
        self.program = {"id": "", "name": "", "text": ""}
        self.commands = []   # (queued_at, command) waiting for the bridge
        self.results = {}    # command id -> {"ok": bool, "message": str}
        self.next_cmd_id = 1
        self.console = deque(maxlen=CONSOLE_LINES)
        self.console_seq = 0
        self.cmd_info = {}   # command id -> (queued_at, description), for the log
        self.bridge_updates = 0
        self.offline_since = None
        self.job_started = None      # time.time() when the running job started (None when no job runs)
        self.run_since = None        # time.time() when _hw_run last went on (a job, or homing, a jog, MDI...)
        self.run_low_line = None     # lowest program line seen since then
        self.run_late = False        # that run was already going when the server first heard from TNG

    # ----- machine commands: browser -> server -> bridge (in its /api/state reply) -----

    def queue_command(self, cmd, first=False):
        with self.cond:
            cmd = dict(cmd, id=self.next_cmd_id)
            self.next_cmd_id += 1
            self.commands.insert(0 if first else len(self.commands), (time.time(), cmd))
            desc = cmd.get("f") or cmd.get("name") or cmd.get("op")
            self.cmd_info[cmd["id"]] = (time.time(), desc)
            log_bridge.debug("command #%d queued: %s %s", cmd["id"], cmd.get("op"), desc)
            return cmd["id"]

    def take_commands(self):
        """Hand the fresh commands to the bridge; expire the stale ones."""
        with self.cond:
            now = time.time()
            fresh = []
            for queued_at, cmd in self.commands:
                if now - queued_at <= COMMAND_TTL:
                    fresh.append(cmd)
                else:
                    self.results[cmd["id"]] = {"ok": False, "message": "TNG did not pick up the command in time"}
                    log_bridge.warning("command #%d (%s) expired: the bridge did not pick it up within %.0f s",
                                       cmd["id"], cmd.get("op"), COMMAND_TTL)
            if fresh:
                log_bridge.debug("handing %d command(s) to the bridge: %s", len(fresh),
                                 ", ".join("#%d" % c["id"] for c in fresh))
            self.commands = []
            self.cond.notify_all()
            return fresh

    def add_results(self, results):
        with self.cond:
            for r in results:
                if isinstance(r, dict) and "id" in r:
                    self.results[r["id"]] = {"ok": bool(r.get("ok")), "message": str(r.get("message") or ""),
                                             "value": r.get("value")}
                    queued_at, desc = self.cmd_info.pop(r["id"], (None, "?"))
                    took = " in %d ms" % ((time.time() - queued_at) * 1000) if queued_at else ""
                    (log_bridge.debug if r.get("ok") else log_bridge.warning)(
                        "command #%s (%s) %s%s%s", r["id"], desc, "ok" if r.get("ok") else "FAILED", took,
                        (": " + str(r.get("message"))) if r.get("message") else "")
            self.cond.notify_all()

    def wait_result(self, cmd_id):
        end = time.time() + COMMAND_WAIT
        with self.cond:
            while cmd_id not in self.results:
                for queued_at, cmd in self.commands:
                    if cmd["id"] == cmd_id and time.time() - queued_at > COMMAND_TTL:
                        self.commands.remove((queued_at, cmd))
                        log_bridge.warning("command #%d dropped: the bridge is not responding", cmd_id)
                        return {"ok": False, "message": "TNG bridge is not responding - command dropped"}
                remaining = end - time.time()
                if remaining <= 0:
                    log_bridge.warning("command #%d: no answer from TNG within %.0f s", cmd_id, COMMAND_WAIT)
                    self.cmd_info.pop(cmd_id, None)
                    return {"ok": False, "message": "No answer from TNG"}
                self.cond.wait(min(remaining, 0.5))
            return self.results.pop(cmd_id)

    # ----- console: what happened, for the dashboard's Console tab -----

    def log(self, kind, text):
        """A line for the dashboard's Console tab (also written to the log). kind: info | ok | warn | err | cmd | tng"""
        level = logging.ERROR if kind == "err" else logging.WARNING if kind == "warn" else logging.INFO
        log_machine.log(level, "%s%s", "command: " if kind == "cmd" else "", text)
        with self.cond:
            self.console_seq += 1
            self.console.append({"seq": self.console_seq, "t": time.time(), "kind": kind, "text": text})
            self.cond.notify_all()

    def console_since(self, after):
        with self.cond:
            return [line for line in self.console if line["seq"] > after]

    def _log_changes(self, old, new):
        """Turn state changes reported by the bridge into console lines."""
        def changed(key):
            return bool(old.get(key)) != bool(new.get(key))
        if changed("estop"):
            self.log("err" if new.get("estop") else "info", "E-stop active" if new.get("estop") else "E-stop released")
        if new.get("file") != old.get("file") and new.get("file"):
            self.log("info", "Program loaded: %s" % new["file"])
        if changed("job"):
            if new.get("job"):
                self.log("info", "Job started: %s" % (new.get("file") or "program"))
                if TUNING:
                    TUNING.job_started(new.get("file"))
            else:
                took = ""
                if self.job_started:
                    secs = int(time.time() - self.job_started)
                    took = " after %d:%02d:%02d" % (secs // 3600, secs // 60 % 60, secs % 60)
                self.log("info", "Job ended at line %s of %s%s" % (new.get("line", "?"), new.get("line_count", "?"), took))
                name = TUNING.job_ended(int(old.get("line") or 0), int(old.get("line_count") or 0)) if TUNING else None
                if name is not None:
                    self.log("ok", "%s has adjusted feeds: mark in the Feeds tab whether they worked" % name)
        if changed("paused"):
            self.log("warn" if new.get("paused") else "info", "Paused" if new.get("paused") else "Resumed")
        # Only in the log: useful when reconstructing what happened.
        if new.get("tool") != old.get("tool") or new.get("tool_diameter") != old.get("tool_diameter"):
            log_machine.info("tool changed: T%s -> T%s %s (diameter from TNG: %s)", old.get("tool"), new.get("tool"),
                             new.get("tool_name") or "", new.get("tool_diameter") or "unknown")
        if new.get("units") != old.get("units") or new.get("coordsys") != old.get("coordsys"):
            log_machine.info("units %s, coordinate system %s", new.get("units"), new.get("coordsys") or "-")
        if changed("idle"):
            log_machine.debug("machine %s", "idle" if new.get("idle") else "busy")

    def _mark_job(self, state):
        """Set state["job"]: is the machine running the loaded program, not just moving?

        TNG's _hw_run is on for every motion it executes: homing, jogging and MDI as well as
        a program. So a run only counts as a job once a program is loaded and its line number
        moves up by JOB_CONFIRM_LINES from the lowest it was during the run; from then on it
        stays a job until _hw_run goes off. The job start time is when _hw_run went on, kept
        here so a dashboard opened mid-job still shows the real elapsed time.
        """
        if not state.get("running"):
            self.run_since = self.run_low_line = self.job_started = None
            state["job"] = False
            return
        line = int(state.get("line") or 0)
        if self.run_since is None:
            self.run_since, self.run_low_line = time.time(), line
            self.run_late = not self.state
        self.run_low_line = min(self.run_low_line, line)
        if self.job_started is None and state.get("line_count") and state.get("file") \
                and line >= self.run_low_line + JOB_CONFIRM_LINES:
            self.job_started = self.run_since
            log_machine.info("job confirmed: line %d of %d, %.1f s after the run started",
                             line, state["line_count"], time.time() - self.run_since)
        state["job"] = self.job_started is not None
        state["job_late"] = state["job"] and self.run_late

    def set_state(self, state, source=""):
        with self.cond:
            was_running = bool(self.state.get("running"))
            self._mark_job(state)
            if state.get("running") != was_running and self.state:
                log_machine.debug("_hw_run %s at line %s of %s", "on" if state.get("running") else "off",
                                  state.get("line"), state.get("line_count"))
            gap = time.time() - self.last_state_time
            if source and gap >= BRIDGE_TIMEOUT:
                if self.offline_since:
                    log_bridge.info("connected from %s (protocol %s) after %.0f s offline",
                                    source, state.get("bridge_protocol"), time.time() - self.offline_since)
                else:
                    log_bridge.info("connected from %s (protocol %s)", source, state.get("bridge_protocol"))
                self.offline_since = None
                self.log("ok", "TNG bridge connected")
            else:
                if source and gap > BRIDGE_GAP_WARN:
                    log_bridge.warning("no update from the bridge for %.1f s (TNG busy, or the Pi overloaded?)", gap)
                if self.state:
                    self._log_changes(self.state, state)
            if NOTIFY:  # also after a reconnect, so a job that ended meanwhile is noticed
                NOTIFY.on_state(self.state, state)
            self.bridge_updates += 1
            self.last_state_time = time.time()
            self.state = state
            self.state_seq += 1
            self.last_update = time.time()
            self.cond.notify_all()

    def set_program(self, name, text):
        pid = hashlib.sha1((name + "\0" + text).encode("utf-8", "replace")).hexdigest()[:16]
        with self.cond:
            self.program = {"id": pid, "name": name, "text": text}
            self.last_update = time.time()
            self.cond.notify_all()
        return pid

    def snapshot(self):
        with self.cond:
            s = dict(self.state)
            s["program_id"] = self.program["id"]
            s["program_name"] = self.program["name"]
            s["bridge_online"] = (time.time() - self.last_update) < BRIDGE_TIMEOUT
            s["server_time"] = time.time()
            s["job_started"] = self.job_started
            seq = self.state_seq
        s["camera"], s["camera_problem"] = camera_state()
        s["camera_view"] = bool(SETTINGS["camera_view"])
        s["machine_name"] = SETTINGS["name"]
        s["tool_view"] = {"enabled": bool(SETTINGS["tool_shape"]), "cam": SETTINGS["tool_cam"]}
        s["log_debug"] = LOGS.debug_enabled()
        s["files_enabled"] = bool(CONFIG.files_dir)
        s["system"] = SYSTEM.latest if SYSTEM else None
        s["console_seq"] = HUB.console_seq
        s["tuning_seq"] = TUNING.seq if TUNING else 0
        s["file_rel"] = files_rel(s.get("file"))
        s["update"] = UPDATER.summary() if UPDATER else None
        s["os_updates"] = OS_PACKAGES.count() if OS_PACKAGES else None
        return seq, s


# ---------------------------------------------------------------------------
# Camera: ffmpeg -> MJPEG frames -> multipart HTTP stream
# ---------------------------------------------------------------------------

CAMERA_IDLE_STOP = 10.0   # stop ffmpeg this many seconds after the last viewer leaves
CAMERA_STALL = 10.0       # restart ffmpeg if it produces no data for this long
CAMERA_KEEPALIVE = 2.0    # resend a frame this often so dead viewer connections get noticed
# 16x9 dark JPEG sent while there is no camera image
NO_SIGNAL_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQq"
    "KiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAA"
    "AAAAAgMQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAJABADASIAAhEAAxEA/9oADAMBAAIRAxEA"
    "PwCKAGm//9k=")
SYS_V4L = "/sys/class/video4linux"
V4L_BY_ID = "/dev/v4l/by-id"
# Video devices of the Pi itself (hardware codecs, image processor), not cameras
NOT_CAMERAS = ("bcm2835-codec", "bcm2835-isp", "rpivid", "rpi-hevc", "pispbe", "hevc")


def _read_text(path, default=""):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def list_cameras():
    """Capture devices as [{"path", "label"}], by their stable /dev/v4l/by-id name where there is one
    (a USB camera keeps that name when it is plugged into another port)."""
    by_id = {}
    try:
        for n in sorted(os.listdir(V4L_BY_ID)):
            full = os.path.join(V4L_BY_ID, n)
            by_id.setdefault(os.path.realpath(full), full)
    except OSError:
        pass
    try:
        names = os.listdir(SYS_V4L)
    except OSError:
        return []
    cams = []
    for n in sorted(names, key=lambda n: int(n[5:]) if n[5:].isdigit() else 1 << 30):
        base = os.path.join(SYS_V4L, n)
        # A USB camera has several nodes; index 0 is the picture, the others metadata.
        if not n.startswith("video") or _read_text(os.path.join(base, "index"), "0") != "0":
            continue
        name = _read_text(os.path.join(base, "name"), n)
        if name.startswith(NOT_CAMERAS):
            continue
        dev = "/dev/" + n
        cams.append({"path": by_id.get(dev, dev), "label": "%s (%s)" % (name, dev)})
    return cams


def camera_state():
    """(camera, problem) for the dashboard: {"live"} when there is a camera to stream, else
    None and why not, so the camera panel can say why it shows no picture."""
    if not CAMERA:
        return None, "The camera can't run: %s." % (CONFIG.camera_note or "it is turned off on the server")
    if CAMERA.enabled():
        return {"live": CAMERA.live()}, ""
    if CAMERA.choice == "none":
        return None, "The camera is set to Off in Settings → Camera."
    return None, "No camera found on the Pi. Check its USB cable, then press Rescan in Settings → Camera."


class Camera:
    """Runs ffmpeg while at least one viewer is connected and keeps the latest JPEG frame.

    With a V4L2 device it first asks the camera for MJPEG and copies the frames
    untouched (almost no CPU on a Raspberry Pi). If the camera can't do MJPEG it
    falls back to raw capture + JPEG encoding in ffmpeg.

    `choice` is "auto" (the first camera found), "none", or a device path.
    """

    def __init__(self, choice="auto", size="", fps=0, command=""):
        self.choice, self.size, self.fps, self.command = choice, size, fps, command
        self.cond = threading.Condition()
        self.frame = None
        self.frame_seq = 0
        self.frame_time = 0.0
        self.clients = 0
        self.transcode = False       # current capture mode for a V4L2 device
        self.mode_confirmed = False  # a mode has produced frames: stop alternating
        self.proc = None
        self.stop_reason = ""
        self.generation = 0          # bumped when the device changes
        self._resolved = (0.0, None)
        self._reported = set()  # errors already printed since the last good capture
        threading.Thread(target=self._run, daemon=True).start()

    def device(self):
        """The device to open now, or None. Looked up at most every few seconds."""
        if self.choice == "none":
            return None
        if self.choice != "auto":
            return self.choice
        t, dev = self._resolved
        if time.time() - t > 3.0:
            cams = list_cameras()
            dev = cams[0]["path"] if cams else None
            self._resolved = (time.time(), dev)
        return dev

    def enabled(self):
        """Whether there is a camera to stream. A chosen camera that is unplugged counts
        (it shows as 'no signal'); 'auto' without any camera doesn't."""
        return bool(self.command) or self.device() is not None

    def set_choice(self, choice):
        with self.cond:
            self.choice = choice
            self._resolved = (0.0, None)
            self.transcode = self.mode_confirmed = False
            self.generation += 1
            self._reported.clear()
            if self.proc:
                self.stop_reason = "camera changed"
                self.proc.kill()  # _run starts over with the new device
            self.cond.notify_all()
        log_camera.info("camera set to %s", choice)

    def live(self):
        return time.time() - self.frame_time < 3.0

    def add_client(self):
        with self.cond:
            self.clients += 1
            self.cond.notify_all()
            log_camera.debug("viewer added (%d watching)", self.clients)

    def remove_client(self):
        with self.cond:
            self.clients -= 1
            log_camera.debug("viewer left (%d watching)", self.clients)

    def wait_frame(self, last_seq, timeout):
        """Return (jpeg, seq): a newer frame, or after `timeout` a keepalive frame."""
        with self.cond:
            self.cond.wait_for(lambda: self.frame_seq != last_seq, timeout=timeout)
            if self.frame is not None and self.live():
                return self.frame, self.frame_seq
            return NO_SIGNAL_JPEG, self.frame_seq

    def _cmd(self, device):
        if self.command:
            return shlex.split(self.command)
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "v4l2"]
        if not self.transcode:
            cmd += ["-input_format", "mjpeg"]
        if self.size:
            cmd += ["-video_size", self.size]
        if self.fps:
            cmd += ["-framerate", str(self.fps)]
        cmd += ["-i", device]
        cmd += ["-c:v", "mjpeg", "-q:v", "6"] if self.transcode else ["-c:v", "copy"]
        return cmd + ["-f", "mjpeg", "-"]

    def _run(self):
        while True:
            with self.cond:
                self.cond.wait_for(lambda: self.clients > 0)
            device = None if self.command else self.device()
            if not self.command and not device:
                with self.cond:
                    self.cond.wait(2.0)  # nothing to open; woken early when the choice changes
                continue
            gen = self.generation
            got = self._capture(device, gen)
            if gen != self.generation:
                continue  # switched to another device meanwhile: start fresh
            if got:
                self.mode_confirmed = True
            else:
                if not self.command and not self.mode_confirmed:
                    self.transcode = not self.transcode  # try the other capture mode next
                time.sleep(2.0)

    def _capture(self, device, gen):
        """Run one ffmpeg process until it dies, stalls or nobody watches. True if it produced frames."""
        cmd = self._cmd(device)
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE)
        except OSError as e:
            self._report("cannot start %s: %s" % (cmd[0], e))
            return False
        started = time.time()
        log_camera.info("starting capture (pid %d): %s", proc.pid, " ".join(cmd))
        with self.cond:
            self.proc = proc
            self.stop_reason = ""
            if gen != self.generation:
                self.stop_reason = "camera changed"
                proc.kill()  # the choice changed while starting

        errors = deque(maxlen=20)
        threading.Thread(target=lambda: errors.extend(
            ln.decode("utf-8", "replace").strip() for ln in proc.stderr), daemon=True).start()

        last_data = [time.time()]
        stop = threading.Event()

        def watchdog():
            idle_since = None
            while not stop.wait(1.0):
                now = time.time()
                with self.cond:
                    idle_since = None if self.clients else (idle_since or now)
                if now - last_data[0] > CAMERA_STALL or (idle_since and now - idle_since > CAMERA_IDLE_STOP):
                    self.stop_reason = ("no viewers for %d s" % CAMERA_IDLE_STOP if idle_since and
                                        now - idle_since > CAMERA_IDLE_STOP else
                                        "stalled: no data from the camera for %d s" % CAMERA_STALL)
                    proc.kill()
                    return
        threading.Thread(target=watchdog, daemon=True).start()

        got = False
        frames = 0
        buf = bytearray()
        try:
            while True:
                chunk = proc.stdout.read1(65536)
                if not chunk:
                    break
                last_data[0] = time.time()
                buf += chunk
                # Split the concatenated JPEGs on SOI/EOI markers (0xFFD9 can't occur
                # inside entropy-coded data, so this is safe for webcam frames).
                while True:
                    start = buf.find(b"\xff\xd8")
                    if start < 0:
                        del buf[:-1]
                        break
                    end = buf.find(b"\xff\xd9", start + 2)
                    if end < 0:
                        del buf[:start]
                        break
                    self._publish(bytes(buf[start:end + 2]))
                    got = True
                    frames += 1
                    del buf[:end + 2]
                if len(buf) > 16 * 1024 * 1024:
                    buf.clear()
        finally:
            stop.set()
            proc.kill()
            code = proc.wait()
            with self.cond:
                self.proc = None
        reason = self.stop_reason or "exited with code %s" % code
        took = time.time() - started
        (log_camera.info if got else log_camera.debug)(
            "capture stopped after %.0f s, %d frames (%.1f/s): %s", took, frames, frames / max(took, 0.001), reason)
        if errors:
            log_camera.debug("%s said: %s", cmd[0], " | ".join(errors))
        if got:
            self._reported.clear()
        else:
            self._report("%s produced no image%s" % (cmd[0], (" - " + " | ".join(list(errors)[-3:])) if errors else ""))
        return got

    def _publish(self, jpeg):
        with self.cond:
            self.frame = jpeg
            self.frame_seq += 1
            self.frame_time = time.time()
            self.cond.notify_all()

    def _report(self, msg):
        if msg not in self._reported:  # don't flood the log while a camera is unplugged
            log_camera.warning(msg)
            self._reported.add(msg)
        else:
            log_camera.debug(msg)


# ---------------------------------------------------------------------------
# Raspberry Pi health: CPU, RAM, temperature, disk, power (Linux only)
# ---------------------------------------------------------------------------

PROC_STAT = "/proc/stat"
PROC_MEMINFO = "/proc/meminfo"
PROC_UPTIME = "/proc/uptime"
THERMAL_ZONE = "/sys/class/thermal/thermal_zone0/temp"


class SystemStats:
    """Samples the Pi's health every few seconds; `latest` is sent with every state update."""

    def __init__(self, interval=2.0):
        self.interval = interval
        self.latest = None
        self._last_cpu = None
        self._throttled = None
        self._throttle_checked = 0.0
        self._levels = {}   # last reported level per warning, so each change is logged once
        threading.Thread(target=self._run, daemon=True).start()

    @staticmethod
    def available():
        return os.path.exists(PROC_STAT)

    def _run(self):
        while True:
            try:
                self.latest = self._sample()
                self._warn(self.latest)
            except Exception:  # never let a stats hiccup take the server down
                log_system.exception("system stats failed")
            time.sleep(self.interval)

    def _level(self, key, level, text):
        """Log `text` when the level of `key` changes (None = all fine)."""
        if self._levels.get(key) == level:
            return
        if level or key in self._levels:
            log_system.log(logging.WARNING if level else logging.INFO, text)
            if NOTIFY and key in ("power", "temp"):
                NOTIFY.event("pi", text=text)
        self._levels[key] = level

    def _warn(self, s):
        t = s.get("throttled")
        if t is not None:
            now = t & 0xF
            words = [w for bit, w in ((1, "under-voltage"), (2, "CPU frequency capped"), (4, "throttled"),
                                      (8, "temperature limit")) if now & bit]
            self._level("power", now or None, "Pi power/temperature: " + (", ".join(words) if words else "back to normal")
                        + " (vcgencmd get_throttled = 0x%x)" % t)
        temp = s.get("temp")
        if temp is not None:
            self._level("temp", "hot" if temp >= 80 else "warm" if temp >= 75 else None,
                        "Pi temperature %.0f \u00b0C%s" % (temp, " - the Pi slows itself down from 80 \u00b0C"
                                                            if temp >= 75 else ""))
        if s.get("mem_total"):
            used = s["mem_used"] / s["mem_total"]
            self._level("mem", "high" if used >= 0.9 else None, "Pi memory %.0f %% used" % (used * 100))
        if s.get("disk_total"):
            used = s["disk_used"] / s["disk_total"]
            self._level("disk", "high" if used >= 0.9 else None, "Pi disk %.0f %% full" % (used * 100))

    def _cpu_percent(self):
        with open(PROC_STAT) as f:
            vals = [int(v) for v in f.readline().split()[1:]]
        idle, total = vals[3] + (vals[4] if len(vals) > 4 else 0), sum(vals)  # idle + iowait
        prev, self._last_cpu = self._last_cpu, (idle, total)
        if not prev or total == prev[1]:
            return None
        return 100.0 * (1 - (idle - prev[0]) / (total - prev[1]))

    def _sample(self):
        s = {"cpu": self._cpu_percent()}
        mem = {}
        with open(PROC_MEMINFO) as f:
            for line in f:
                key, _, rest = line.partition(":")
                mem[key] = int(rest.split()[0]) * 1024
        if "MemTotal" in mem and "MemAvailable" in mem:
            s["mem_total"] = mem["MemTotal"]
            s["mem_used"] = mem["MemTotal"] - mem["MemAvailable"]
        try:
            with open(THERMAL_ZONE) as f:
                s["temp"] = int(f.read().strip()) / 1000.0
        except (OSError, ValueError):
            s["temp"] = None
        try:
            du = shutil.disk_usage("/")
            s["disk_total"], s["disk_used"] = du.total, du.used
        except OSError:
            pass
        try:
            with open(PROC_UPTIME) as f:
                s["uptime"] = float(f.read().split()[0])
        except (OSError, ValueError):
            pass
        s["throttled"] = self._get_throttled()
        return s

    def _get_throttled(self):
        """Raspberry Pi firmware flags (under-voltage, throttling), checked every 10 s."""
        if time.time() - self._throttle_checked >= 10.0:
            self._throttle_checked = time.time()
            exe = shutil.which("vcgencmd")
            if exe:
                try:
                    out = subprocess.run([exe, "get_throttled"], capture_output=True, text=True, timeout=3).stdout
                    self._throttled = int(out.strip().split("=")[1], 16)  # "throttled=0x50005"
                except (OSError, subprocess.SubprocessError, ValueError, IndexError):
                    self._throttled = None
        return self._throttled


# ---------------------------------------------------------------------------
# Software update from GitHub (the app folder must be a git clone; see update.sh)
# ---------------------------------------------------------------------------

APP_DIR = os.path.dirname(os.path.abspath(__file__))
UPDATE_SCRIPT = os.path.join(APP_DIR, "update.sh")
UPDATE_CHECK_EVERY = 6 * 3600
UPDATES_OFF_REASON = "updates are not available"



class DemoStats:
    """--demo on a computer that isn't a Pi: made-up Pi health, so the rings have something to show."""

    def __init__(self):
        self.started = time.time() - 2 * 86400 - 7 * 3600

    @property
    def latest(self):
        t = time.time()
        gb = 1024 ** 3
        return {"cpu": 18 + 8 * math.sin(t / 7), "mem_total": 8 * gb, "mem_used": int((1.9 + 0.1 * math.sin(t / 30)) * gb),
                "temp": 52 + 3 * math.sin(t / 20), "disk_total": 58 * gb, "disk_used": 11 * gb,
                "uptime": t - self.started, "throttled": 0}

class Updater:
    def __init__(self):
        self.lock = threading.Lock()
        self.info = {"git": True, "checked": None, "error": ""}
        self.busy = False
        self.check_lock = threading.Lock()   # one GitHub check at a time, see check()
        threading.Thread(target=self._auto_check, daemon=True).start()

    @staticmethod
    def available():
        return bool(shutil.which("git")) and os.path.isdir(os.path.join(APP_DIR, ".git"))

    def _git(self, *args, timeout=30):
        r = subprocess.run(["git", *args], cwd=APP_DIR, capture_output=True, text=True, timeout=timeout)
        if r.returncode:
            raise RuntimeError((r.stderr or r.stdout).strip() or "git %s failed" % args[0])
        return r.stdout.rstrip()  # keep leading spaces: `git status --porcelain` lines start with one

    def _commit(self, ref):
        sha, subject, date = self._git("log", "-1", "--format=%h%x1f%s%x1f%cI", ref).split("\x1f")
        return {"sha": sha, "subject": subject, "date": date}

    def refresh(self, fetch):
        info = {"git": True, "error": "", "checked": self.info.get("checked")}
        try:
            if fetch:
                self._git("fetch", "--quiet", "origin", timeout=60)
                info["checked"] = time.time()
            info["branch"] = self._git("rev-parse", "--abbrev-ref", "HEAD")
            info["current"] = self._commit("HEAD")
            try:
                info["latest"] = self._commit("@{u}")
                log = self._git("log", "--format=%h%x1f%s%x1f%cI%x1f%an", "HEAD..@{u}")
                info["commits"] = [dict(zip(("sha", "subject", "date", "author"), line.split("\x1f")))
                                   for line in log.splitlines() if line]
                info["behind"] = len(info["commits"])
                info["ahead"] = int(self._git("rev-list", "--count", "@{u}..HEAD"))
            except RuntimeError:
                info["error"] = "this branch has no counterpart on GitHub"
            info["dirty"] = [line[3:] for line in
                             self._git("status", "--porcelain", "--untracked-files=no").splitlines()]
            info["can_rollback"] = os.path.isfile(os.path.join(APP_DIR, ".git", "pcnc_previous"))
        except (RuntimeError, OSError, subprocess.SubprocessError) as e:
            info["error"] = str(e)
        info["auto_restart"] = bool(os.environ.get("INVOCATION_ID"))  # set when systemd runs us
        if info["error"]:
            log_update.warning("update check: %s", info["error"])
        elif fetch:
            log_update.info("checked GitHub: %s (installed %s)", "%d update(s) available" % info.get("behind", 0)
                            if info.get("behind") else "up to date", info["current"]["sha"])
        with self.lock:
            self.info = info
        return dict(info, ok=not info["error"])

    def status(self):
        with self.lock:
            return dict(self.info, busy=self.busy)

    def summary(self):
        with self.lock:
            return {"behind": self.info.get("behind", 0), "current": (self.info.get("current") or {}).get("sha")}

    def check(self):
        """Check GitHub now. The System page checks each time it opens, so a check may already
        be running (another browser, the 6-hourly one): then wait for it and use its answer."""
        if not self.check_lock.acquire(blocking=False):
            with self.check_lock:
                pass
            with self.lock:
                return dict(self.info, ok=not self.info["error"])
        try:
            return self.refresh(fetch=True)
        finally:
            self.check_lock.release()

    def apply(self, action):
        """Run update.sh (update | rollback). Returns {ok, output, restarting}."""
        with self.lock:
            if self.busy:
                return {"ok": False, "message": "an update is already running"}
            self.busy = True
        try:
            before = self._git("rev-parse", "HEAD")
            r = subprocess.run(["sh", UPDATE_SCRIPT, action], cwd=APP_DIR, capture_output=True, text=True, timeout=180)
            output = (r.stdout + r.stderr).strip()
            changed = self._git("rev-parse", "HEAD") != before
        except (RuntimeError, OSError, subprocess.SubprocessError) as e:
            log_update.exception("%s failed", action)
            return {"ok": False, "message": str(e), "output": str(e)}
        finally:
            with self.lock:
                self.busy = False
        self.refresh(fetch=False)
        restarting = r.returncode == 0 and changed and bool(os.environ.get("INVOCATION_ID"))
        if r.returncode == 0 and changed and not restarting:
            output += "\nRestart server.py to run the new version."
        (log_update.info if r.returncode == 0 else log_update.error)(
            "%s (exit code %d): %s", action, r.returncode, output.replace("\n", " | "))
        return {"ok": r.returncode == 0, "message": output.splitlines()[-1] if output else "",
                "output": output, "restarting": restarting}

    def _auto_check(self):
        time.sleep(20)
        while True:
            self.check()
            time.sleep(UPDATE_CHECK_EVERY)


# ---------------------------------------------------------------------------
# System window: OS packages (apt), reboot / shut down, host details.
# Running these as root needs a sudoers rule; tools/setup-sudo.sh writes it. Without
# it the window still shows what can be upgraded, but can't install or reboot.
# ---------------------------------------------------------------------------

APT_GET = "/usr/bin/apt-get"
SYSTEMCTL = "/usr/bin/systemctl"
# Exactly these command lines are allowed by tools/setup-sudo.sh (sudo compares the arguments).
SUDO_APT_UPDATE = [APT_GET, "update"]
SUDO_APT_UPGRADE = [APT_GET, "-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
                    "upgrade"]
SUDO_POWER = {"reboot": [SYSTEMCTL, "reboot"], "poweroff": [SYSTEMCTL, "poweroff"]}
OS_CHECK_EVERY = 6 * 3600
OS_UPGRADE_TIMEOUT = 3600
APT_LISTS = "/var/lib/apt/lists"
REBOOT_REQUIRED = "/var/run/reboot-required"
C_LOCALE = dict(os.environ, LANG="C", LC_ALL="C")


def sudo_allowed(cmd):
    """True if this user may run exactly `cmd` through sudo without a password."""
    if os.geteuid() == 0:
        return True
    try:
        return subprocess.run(["sudo", "-n", "-l", *cmd], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def as_root(cmd):
    return cmd if os.geteuid() == 0 else ["sudo", "-n", *cmd]


class OsPackages:
    """Raspberry Pi OS package updates through apt: what can be upgraded, and upgrading it."""

    INST = re.compile(r"^Inst (\S+) \[([^\]]+)\] \((\S+)")

    def __init__(self):
        self.lock = threading.Lock()
        self.info = {"checked": None, "packages": [], "error": ""}
        self.job = None   # the running or last upgrade: {running, started, ended, exit, output, who}
        self.check_lock = threading.Lock()   # one apt-get update at a time, see check()
        threading.Thread(target=self._auto_check, name="os-check", daemon=True).start()

    @staticmethod
    def available():
        return (sys.platform.startswith("linux") and os.path.exists(APT_GET)
                and (os.geteuid() == 0 or bool(shutil.which("sudo"))))

    def count(self):
        with self.lock:
            return len(self.info.get("packages") or [])

    def refresh(self, update_lists):
        """Find the upgradable packages; with update_lists, first fetch the package lists (apt-get update)."""
        info = {"error": "", "checked": self.info.get("checked"),
                "can_update": sudo_allowed(SUDO_APT_UPDATE), "can_upgrade": sudo_allowed(SUDO_APT_UPGRADE),
                "can_power": all(sudo_allowed(c) for c in SUDO_POWER.values())}
        try:
            if update_lists and info["can_update"]:
                r = subprocess.run(as_root(SUDO_APT_UPDATE), stdin=subprocess.DEVNULL, capture_output=True,
                                   text=True, timeout=300, env=C_LOCALE)
                if r.returncode:
                    info["error"] = "apt-get update failed: " + (
                        (r.stderr or r.stdout).strip().splitlines() or ["?"])[-1]
                info["checked"] = time.time()
            # A dry run of exactly what "upgrade" would do; needs no root.
            r = subprocess.run([APT_GET, "-s", "-o", "Debug::NoLocking=1", "upgrade"], stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=120, env=C_LOCALE)
            if r.returncode and not info["error"]:
                info["error"] = ((r.stderr or r.stdout).strip().splitlines() or ["apt-get -s upgrade failed"])[-1]
            info["packages"] = [{"name": m.group(1), "from": m.group(2), "to": m.group(3)}
                                for m in map(self.INST.match, r.stdout.splitlines()) if m]
            kept = re.search(r"have been kept back:\n((?: .*\n)+)", r.stdout)
            info["kept_back"] = kept.group(1).split() if kept else []
        except (OSError, subprocess.SubprocessError) as e:
            info["error"] = str(e)
        info["lists_date"] = self._lists_date()
        info["reboot_required"] = os.path.exists(REBOOT_REQUIRED)
        if info["error"]:
            log_update.warning("OS package check: %s", info["error"])
        elif update_lists:
            log_update.info("OS packages: %d can be upgraded%s", len(info["packages"]),
                            "" if info["can_update"] else " (package lists not refreshed: no sudo rule)")
        with self.lock:
            self.info = info
        return self.status()

    def check(self):
        """Fetch the package lists and look again. When a check is already running (another
        browser, the 6-hourly one), wait for it and use its answer: apt allows one at a time."""
        if not self.check_lock.acquire(blocking=False):
            with self.check_lock:
                pass
            return self.status()
        try:
            return self.refresh(update_lists=True)
        finally:
            self.check_lock.release()

    @staticmethod
    def _lists_date():
        try:
            times = [e.stat().st_mtime for e in os.scandir(APT_LISTS) if e.name.endswith("Release")]
            return max(times) if times else None
        except OSError:
            return None

    def status(self):
        with self.lock:
            out = dict(self.info)
            job = dict(self.job) if self.job else None
        if job:
            job["output"] = list(job["output"])[-400:]
            out["job"] = job
        out["busy"] = bool(job and job["running"])
        return out

    def upgrade(self, who):
        with self.lock:
            if self.job and self.job["running"]:
                return {"ok": False, "message": "an upgrade is already running"}
            if not self.info.get("can_upgrade"):
                return {"ok": False, "message": "not allowed: run tools/setup-sudo.sh on the Pi once (see README)"}
            self.job = {"running": True, "started": time.time(), "ended": None, "exit": None,
                        "output": deque(maxlen=2000), "who": who}
        HUB.log("cmd", "OS package upgrade started (%s)" % who)
        threading.Thread(target=self._run_upgrade, args=(self.job,), name="os-upgrade", daemon=True).start()
        return {"ok": True, "message": "upgrade started"}

    def _run_upgrade(self, job):
        try:
            proc = subprocess.Popen(as_root(SUDO_APT_UPGRADE), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, env=C_LOCALE, bufsize=1)
            timer = threading.Timer(OS_UPGRADE_TIMEOUT, proc.kill)
            timer.start()
            for line in proc.stdout:
                job["output"].append(line.rstrip("\n"))
            code = proc.wait()
            timer.cancel()
        except OSError as e:
            job["output"].append(str(e))
            code = -1
        with self.lock:
            job.update(running=False, ended=time.time(), exit=code)
        tail = " | ".join(list(job["output"])[-5:])
        (log_update.info if code == 0 else log_update.error)("OS upgrade (exit code %d): %s", code, tail)
        HUB.log("ok" if code == 0 else "err", "OS package upgrade %s" % (
            "finished" if code == 0 else "FAILED (exit code %d) - see the System window" % code))
        self.refresh(update_lists=False)
        if os.path.exists(REBOOT_REQUIRED):
            HUB.log("warn", "The Pi needs a reboot to finish the OS upgrade")

    def _auto_check(self):
        time.sleep(30)
        while True:
            if not HUB.snapshot()[1].get("running") and not (self.job and self.job["running"]):
                try:
                    self.check()
                except Exception:
                    log_update.exception("OS package check failed")
            time.sleep(OS_CHECK_EVERY)


SEEN_FILE = os.path.join(APP_DIR, ".git", "pcnc_seen")   # the version and boot seen at the last start
BOOT_ID = "/proc/sys/kernel/random/boot_id"               # a new one at each boot of the Pi
STOP_ANNOUNCED = False                                   # a reboot / shut down was already reported


def startup_notices():
    """At start: tell Telegram when the Pi has booted since the server last ran, and when the app
    runs another version than last time (an update from the dashboard or update.sh, or a roll back)."""
    if not UPDATER:
        return
    try:
        now = UPDATER._commit("HEAD")
    except (RuntimeError, OSError, subprocess.SubprocessError):
        return
    boot = _read_text(BOOT_ID)
    try:
        with open(SEEN_FILE, encoding="utf-8") as f:
            seen = json.load(f)
    except (OSError, ValueError):
        seen = None
    try:
        with open(SEEN_FILE, "w", encoding="utf-8") as f:
            json.dump({"sha": now["sha"], "boot": boot}, f)
    except OSError as e:
        log_notify.warning("cannot write %s: %s", SEEN_FILE, e)
    if not seen:
        return   # first start: nothing to compare with
    lines = []
    if boot and boot != seen.get("boot"):
        lines.append("\U0001f7e2 <b>Raspberry Pi started</b>: %s is running." % _html(SETTINGS["name"]))
    if now["sha"] != seen.get("sha"):
        back = False
        try:
            UPDATER._git("merge-base", "--is-ancestor", now["sha"], seen.get("sha", ""))
            back = True   # the new version is older: a roll back
        except (RuntimeError, OSError, subprocess.SubprocessError):
            pass
        lines.append("%s <b>Observatory %s</b>: %s → %s\n%s" % (
            "↩️" if back else "✅", "rolled back" if back else "updated", _html(seen.get("sha", "?")),
            now["sha"], _html(now["subject"])))
    if lines:
        NOTIFY.system("\n\n".join(lines))


def power_action(action, who):
    """Reboot or shut down the Pi (the caller makes sure no program runs)."""
    cmd = SUDO_POWER.get(action)
    if not cmd:
        return {"ok": False, "message": "unknown action"}
    if not sudo_allowed(cmd):
        return {"ok": False, "message": "not allowed: run tools/setup-sudo.sh on the Pi once (see README)"}
    word = "Reboot" if action == "reboot" else "Shut down"
    HUB.log("warn", "%s of the Pi requested (%s)" % (word, who))

    def run():
        global STOP_ANNOUNCED
        time.sleep(1.0)  # let the answer reach the browser first
        if NOTIFY:
            NOTIFY.system("%s <b>%s</b> the Raspberry Pi (asked from %s)." % (
                "\U0001f504" if action == "reboot" else "\U0001f534",
                "Rebooting" if action == "reboot" else "Shutting down", _html(who)), now=True)
            STOP_ANNOUNCED = True   # don't report the service stopping as well
        try:
            r = subprocess.run(as_root(cmd), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
            if r.returncode:
                HUB.log("err", "%s failed: %s" % (word, (r.stderr or r.stdout).strip()))
        except (OSError, subprocess.SubprocessError) as e:
            HUB.log("err", "%s failed: %s" % (word, e))
    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "message": "%s in a moment" % word}


# ---------------------------------------------------------------------------
# Telegram notifications and the job timelapse.
# The bot only reports: messages and camera photos about jobs, and answers /status and
# /photo in the configured chat. It can't control the machine. It only makes outgoing
# connections to Telegram (long polling), so nothing on the Pi is opened to the internet.
# ---------------------------------------------------------------------------

TELEGRAM_API = os.environ.get("PCNC_TELEGRAM_API", "https://api.telegram.org")  # changeable for testing
TELEGRAM_POLL = 50              # seconds a getUpdates long poll waits for messages
TELEGRAM_MAX_UPLOAD = 49 * 2**20
TELEGRAM_OLD_MESSAGE = 120      # commands older than this (s) when they arrive are ignored
SNAPSHOT_WAIT = 8.0             # how long a photo may wait for the camera to start
SNAPSHOT_WARMUP = 1.5           # a camera that was off needs a moment to set its exposure
SNAPSHOT_HOLD = 30.0            # keep the camera running this long after a still was asked for: a program that
                                # polls stills (Home Assistant: every 10 s) would otherwise restart it every time
TIMELAPSE_DIR = os.path.join(APP_DIR, "timelapses")
TIMELAPSE_KEEP = 20             # finished timelapses kept on the Pi
TIMELAPSE_MAX_FRAMES = 300      # frames kept per job: more are thinned out while recording
TIMELAPSE_SECONDS = 20          # aimed length of the finished video
TIMELAPSE_WIDTH = 960


def camera_snapshot(wait=SNAPSHOT_WAIT):
    """A fresh JPEG from the camera (started for a moment if nobody watches), or None."""
    if not CAMERA or not CAMERA.enabled():
        return None
    CAMERA.add_client()
    try:
        with CAMERA.cond:
            seq = CAMERA.frame_seq
            ready = time.time() + (0 if CAMERA.live() else SNAPSHOT_WARMUP)
            CAMERA.cond.wait_for(lambda: CAMERA.frame_seq != seq and CAMERA.frame_time >= ready, timeout=wait)
            return CAMERA.frame if CAMERA.live() else None
    finally:
        CAMERA.remove_client()


class SnapshotHold:
    """Counts as one camera viewer from a still-picture request until SNAPSHOT_HOLD seconds after the last one.

    Without it the camera stops 10 s after each /api/camera.jpg and starts again (with its
    warm-up) for the next one, so a program polling stills would restart it every time."""

    def __init__(self):
        self.lock = threading.Lock()
        self.timer = None
        self.gen = 0

    def holding(self):
        return self.timer is not None

    def touch(self):
        with self.lock:
            self.gen += 1
            if self.timer is None:
                CAMERA.add_client()
                log_camera.info("still pictures asked for: the camera keeps running until %d s after the last one",
                                SNAPSHOT_HOLD)
            else:
                self.timer.cancel()
            self.timer = threading.Timer(SNAPSHOT_HOLD, self._expire, (self.gen,))
            self.timer.daemon = True
            self.timer.start()

    def _expire(self, gen):
        with self.lock:
            if gen != self.gen:  # a newer request has restarted the clock
                return
            self.timer = None
            CAMERA.remove_client()
            log_camera.info("no still picture asked for %d s", SNAPSHOT_HOLD)


SNAPSHOT_HOLD_STATE = SnapshotHold()


class Timelapse:
    """Takes a camera photo every few seconds during a job, and makes a short video of them at the end.

    The frames of a long job are thinned out while recording (every other one is dropped and the
    interval doubled), so a job of any length needs at most 2 x TIMELAPSE_MAX_FRAMES photos on disk.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.rec = None
        try:
            os.makedirs(TIMELAPSE_DIR, exist_ok=True)
            for e in os.scandir(TIMELAPSE_DIR):  # frames of a job the server didn't see end
                if e.is_dir() and e.name.startswith(".frames-"):
                    shutil.rmtree(e.path, ignore_errors=True)
        except OSError as e:
            log_notify.warning("timelapse folder %s: %s", TIMELAPSE_DIR, e)

    def start(self, job_file):
        if not (SETTINGS["timelapse"] and CAMERA and CAMERA.enabled()):
            return
        with self.lock:
            if self.rec:
                return
            folder = os.path.join(TIMELAPSE_DIR, ".frames-%d" % time.time())
            try:
                os.makedirs(folder)
            except OSError as e:
                log_notify.error("timelapse: cannot create %s: %s", folder, e)
                return
            self.rec = {"dir": folder, "file": job_file, "started": time.time(), "stop": threading.Event(),
                        "frames": [], "interval": float(SETTINGS["timelapse_interval"])}
            rec = self.rec
        rec["thread"] = threading.Thread(target=self._record, args=(rec,), name="timelapse", daemon=True)
        rec["thread"].start()
        log_notify.info("timelapse started: a photo every %d s", rec["interval"])

    def _record(self, rec):
        CAMERA.add_client()
        n = 0
        try:
            next_shot = time.time() + SNAPSHOT_WARMUP
            while True:
                stopped = rec["stop"].wait(max(0.0, next_shot - time.time()))
                with CAMERA.cond:
                    jpeg = CAMERA.frame if CAMERA.live() else None
                if jpeg:
                    path = os.path.join(rec["dir"], "%06d.jpg" % n)
                    n += 1
                    try:
                        with open(path, "wb") as f:
                            f.write(jpeg)
                        rec["frames"].append(path)
                    except OSError as e:
                        log_notify.error("timelapse: cannot save a photo: %s", e)
                        break
                if stopped:
                    break  # the photo just taken shows the finished job
                if len(rec["frames"]) >= 2 * TIMELAPSE_MAX_FRAMES:
                    for old in rec["frames"][1::2]:
                        try:
                            os.remove(old)
                        except OSError:
                            pass
                    rec["frames"] = rec["frames"][::2]
                    rec["interval"] *= 2
                    log_notify.info("timelapse: long job, now a photo every %d s", rec["interval"])
                next_shot += rec["interval"]
        finally:
            CAMERA.remove_client()

    def stop(self):
        """End the recording and make the video. Returns its path, or None (no camera, too short)."""
        with self.lock:
            rec, self.rec = self.rec, None
        if not rec:
            return None
        rec["stop"].set()
        rec["thread"].join(30)
        try:
            return self._encode(rec)
        finally:
            shutil.rmtree(rec["dir"], ignore_errors=True)
            self._prune()

    def _encode(self, rec):
        frames = rec["frames"]
        if len(frames) < 3:
            log_notify.info("timelapse: only %d photo(s), no video", len(frames))
            return None
        for i, path in enumerate(frames):  # ffmpeg wants numbers without gaps
            os.replace(path, os.path.join(rec["dir"], "f%06d.jpg" % i))
        fps = max(4, min(30, math.ceil(len(frames) / TIMELAPSE_SECONDS)))
        job = os.path.splitext(os.path.basename(str(rec["file"]).replace("\\", "/")))[0] or "job"
        job = re.sub(r"[^\w.-]+", "_", job)[:60]
        base = os.path.join(TIMELAPSE_DIR, time.strftime("%Y-%m-%d_%H%M", time.localtime(rec["started"])) + "_" + job)
        nice = ["nice", "-n", "10"] if shutil.which("nice") else []
        source = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate", str(fps),
                  "-i", os.path.join(rec["dir"], "f%06d.jpg")]
        attempts = [
            # Standard (limited) range yuv420p: webcams give full-range JPEGs, which phones may not play.
            (base + ".mp4", ["-vf", "scale='min(%d,iw)':-2:out_range=tv,format=yuv420p" % TIMELAPSE_WIDTH,
                             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-color_range", "tv", "-preset", "veryfast",
                             "-crf", "28", "-movflags", "+faststart", "-an"]),
            # ffmpeg without H.264: a GIF (bigger, but Telegram shows it the same way)
            (base + ".gif", ["-vf", "scale='min(480,iw)':-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse"]),
        ]
        t0 = time.time()
        for out, opts in attempts:
            try:
                r = subprocess.run(nice + source + opts + [out], stdin=subprocess.DEVNULL, capture_output=True,
                                   text=True, timeout=900)
            except (OSError, subprocess.SubprocessError) as e:
                log_notify.error("timelapse: ffmpeg failed: %s", e)
                return None
            if r.returncode == 0 and os.path.isfile(out):
                log_notify.info("timelapse: %s (%d photos, %d fps, %.0f KB) made in %.0f s", os.path.basename(out),
                                len(frames), fps, os.path.getsize(out) / 1024, time.time() - t0)
                return out
            log_notify.warning("timelapse: ffmpeg could not make %s: %s", os.path.basename(out),
                               (r.stderr or "").strip().replace("\n", " | ")[-300:])
            try:
                os.remove(out)
            except OSError:
                pass
        return None

    def _prune(self):
        for old in self.list()[TIMELAPSE_KEEP:]:
            try:
                os.remove(os.path.join(TIMELAPSE_DIR, old["name"]))
            except OSError:
                pass

    def list(self):
        """Finished timelapses, newest first."""
        try:
            files = [{"name": e.name, "size": e.stat().st_size, "mtime": e.stat().st_mtime}
                     for e in os.scandir(TIMELAPSE_DIR) if e.is_file() and e.name.endswith((".mp4", ".gif"))]
        except OSError:
            return []
        return sorted(files, key=lambda f: f["mtime"], reverse=True)

    def path(self, name):
        name = os.path.basename(str(name or ""))
        path = os.path.join(TIMELAPSE_DIR, name)
        return path if name.endswith((".mp4", ".gif")) and os.path.isfile(path) else None

    def recording(self):
        return self.rec is not None


def _html(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _job_name(path):
    return os.path.basename(str(path or "").replace("\\", "/")) or "program"


class Notifier:
    """Follows the machine state, runs the timelapse, and reports to Telegram.

    on_state() is called with every state change (under the hub's lock), so it only decides
    what happened and queues it; one worker thread takes photos, makes the timelapse and
    talks to Telegram. A second thread long-polls Telegram for /status and /photo.
    """

    COMMANDS = [("status", "What the machine is doing, with a photo"), ("photo", "A camera photo"),
                ("help", "What this bot does")]

    def __init__(self):
        self.q = queue.Queue()
        self.lock = threading.Lock()
        self.bot = ""             # @username of the bot, once getMe worked
        self.error = ""
        self.chats = {}           # chats that wrote to the bot lately: id -> {"name", "t"}, for Settings
        self.offset = 0
        self.job = None           # {"file", "started", "bucket", "estop"} while a job runs
        self.progress_msg = None  # id of the job's latest progress message (worker thread only), to replace it
        self.poll_wake = threading.Event()
        threading.Thread(target=self._work, name="notify", daemon=True).start()
        threading.Thread(target=self._poll, name="telegram-poll", daemon=True).start()

    # ----- what happened (called with the hub's lock held: only queue) -----

    def on_state(self, old, new):
        if not old:
            return
        # "job", not "running": homing, jogging and MDI moves are not reported (see Hub._mark_job)
        running, was = bool(new.get("job")), bool(old.get("job"))
        if new.get("estop") and not old.get("estop"):  # first: the most urgent message
            self.q.put(("estop", dict(new, line=old.get("line") if was else new.get("line"), running=was)))
        if running and not was:
            # A job that was already going when the server started: only its end is reported.
            self.job = {"file": new.get("file"), "started": time.time(), "bucket": None, "late": bool(new.get("job_late")),
                        "last": time.time()}
            if not self.job["late"]:
                self.q.put(("job_start", dict(new)))
        elif was and not running:
            job, self.job = self.job, None
            self.q.put(("job_end", dict(old, job=job, estop=bool(new.get("estop")))))
        if new.get("paused") != old.get("paused") and running and was:
            self.q.put(("paused" if new.get("paused") else "resumed", dict(new)))
            if self.job:
                self.job["last"] = time.time()  # the timed progress messages count from here
        self._progress(new)

    def _progress(self, new):
        """A progress message at every `notify_progress` % and, when `notify_minutes` is set, also
        when that long has passed since the last message - whichever comes first. A percentage
        step right after a timed message (within half the interval) is skipped: no pairs."""
        job, total = self.job, new.get("line_count") or 0
        if not job or job["late"] or not new.get("job") or not total:
            return
        step, minutes = SETTINGS["notify_progress"], SETTINGS["notify_minutes"]
        pct = 100.0 * (new.get("line") or 0) / total
        if step:
            bucket = int(pct // step)
            if job["bucket"] is None or step != job.get("step"):  # first look, or the setting changed:
                job["bucket"], job["step"] = bucket, step            # nothing to report for what already passed
            elif bucket > job["bucket"]:
                job["bucket"] = bucket
                just_timed = job.get("timed") and time.time() - job["last"] < minutes * 30
                if 0 < bucket * step < 100 and not just_timed:
                    job["last"], job["timed"] = time.time(), False
                    self.q.put(("progress", dict(new, pct=bucket * step)))
                    return
        if minutes and time.time() - job["last"] >= minutes * 60 and not new.get("paused") and pct < 100:
            job["last"], job["timed"] = time.time(), True
            self.q.put(("progress", dict(new, pct=int(pct))))

    def event(self, kind, **data):
        self.q.put((kind, data))

    # ----- the worker -----

    def _work(self):
        while True:
            kind, data = self.q.get()
            try:
                if kind == "job_start" and TIMELAPSE:
                    TIMELAPSE.start(data.get("file"))
                video = TIMELAPSE.stop() if kind == "job_end" and TIMELAPSE else None
                if self.configured():
                    self._report(kind, data, video)
            except Exception:
                log_notify.exception("%s notification failed", kind)

    def _drop_progress(self):
        """Delete the job's last progress message (when Settings say to replace them)."""
        msg, self.progress_msg = self.progress_msg, None
        if msg:
            try:
                self.api("deleteMessage", {"chat_id": SETTINGS["telegram_chat"], "message_id": msg}, timeout=10)
            except RuntimeError as e:  # e.g. older than 48 h, or deleted by hand: leave it
                log_notify.info("could not delete the previous progress message: %s", e)

    def _report(self, kind, d, video=None):
        name = _html(_job_name(d.get("file")))
        photo = SETTINGS["notify_photos"]
        if kind in ("job_start", "job_end"):
            self._drop_progress()  # a leftover from the last job, or this job's last one: the end says it all
        send, quiet = notify_rule(kind)  # Settings: whether to send it, and whether with sound
        if not send:
            return
        if kind == "job_start":
            left = d.get("time_to_end") or -1
            text = "▶️ <b>Job started</b>: %s%s" % (name, "\nEstimated %s" % fmt_duration(left) if left > 0 else "")
        elif kind == "progress":
            left = d.get("time_to_end") or -1
            text = "⏳ <b>%d %%</b> of %s\nLine %s of %s%s" % (d["pct"], name, d.get("line"), d.get("line_count"),
                                                                    ", %s left" % fmt_duration(left) if left > 0 else "")
        elif kind == "job_end":
            job = d.get("job") or {}
            took = " in %s" % fmt_duration(time.time() - job["started"]) if job.get("started") else ""
            line, total = d.get("line") or 0, d.get("line_count") or 0
            if total and line >= total - 2:
                text = "✅ <b>Job finished</b>: %s%s" % (name, took)
            else:
                text = "⏹ <b>Job stopped%s</b>: %s at line %s of %s%s%s" % (
                    " by E-stop" if d.get("estop") else "", name, line, total or "?",
                    " (%d %%)" % (100 * line / total) if total else "", took.replace(" in", " after"))
            if video:
                self._send_file("sendAnimation", "animation", video, text, quiet)
                return
            photo = True  # the end always shows the result: the timelapse, or else a photo
        elif kind == "estop":
            text = "\U0001f6d1 <b>E-STOP</b> on %s%s" % (_html(SETTINGS["name"]), " at line %s of %s" % (
                d.get("line"), name) if d.get("running") or d.get("line") else "")
        elif kind == "paused":
            text = "⏸ <b>Paused</b>: %s at line %s" % (name, d.get("line"))
        elif kind == "resumed":
            text, photo = "▶️ Resumed: %s" % name, False
        elif kind == "bridge_lost":
            text, photo = "⚠️ <b>TNG not reachable</b> during the job (no update for %d s). Check the machine." % (
                BRIDGE_TIMEOUT), False
        elif kind == "pi":
            text, photo = "⚠️ <b>Raspberry Pi</b>: %s" % _html(d.get("text")), False
        else:
            return
        if kind == "progress" and SETTINGS["notify_replace"]:
            # One progress message at a time: the new one, then the previous one goes (as the
            # Moonraker Telegram bot's progress_update_message does), so the chat isn't flooded.
            err, msg = self._send(text, photo=photo, quiet=quiet)
            if not err:
                self._drop_progress()
                self.progress_msg = msg
            return
        self.send(text, photo=photo, quiet=quiet)

    # ----- Telegram -----

    def configured(self):
        return bool(SETTINGS["telegram_token"] and SETTINGS["telegram_chat"])

    def api(self, method, fields=None, file=None, timeout=30):
        """Call the Bot API. `file` = (field, filename, bytes, content type) uploads it."""
        token = SETTINGS["telegram_token"]
        if not token:
            raise RuntimeError("no bot token")
        fields = {k: (json.dumps(v) if isinstance(v, (list, dict)) else str(v)) for k, v in (fields or {}).items()}
        if file:
            boundary = "pcnc" + os.urandom(12).hex()
            parts = []
            for k, v in fields.items():
                parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, k, v)).encode())
            field, filename, data, ctype = file
            parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: %s\r\n\r\n'
                          % (boundary, field, filename, ctype)).encode() + data + b"\r\n")
            parts.append(("--%s--\r\n" % boundary).encode())
            body, ctype = b"".join(parts), "multipart/form-data; boundary=" + boundary
        else:
            body, ctype = urlencode(fields).encode(), "application/x-www-form-urlencoded"
        req = urllib.request.Request("%s/bot%s/%s" % (TELEGRAM_API, token, method), data=body,
                                     headers={"Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                reply = json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                reply = json.loads(e.read() or b"{}")
            except ValueError:
                raise RuntimeError("Telegram answered HTTP %d" % e.code)
        except (urllib.error.URLError, OSError) as e:  # never shows the URL, which holds the token
            raise RuntimeError("cannot reach Telegram (%s)" % getattr(e, "reason", e))
        if not reply.get("ok"):
            raise RuntimeError(reply.get("description") or "Telegram refused the request")
        return reply.get("result")

    def send(self, text, photo=False, quiet=False, chat=None, timeout=30):
        """A message, with a camera photo when asked and available. Returns an error text or ""."""
        return self._send(text, photo, quiet, chat, timeout)[0]

    def _send(self, text, photo=False, quiet=False, chat=None, timeout=30):
        """As send(), returning (error text or "", the message's id or None)."""
        chat = chat or SETTINGS["telegram_chat"]
        jpeg = camera_snapshot() if photo else None
        try:
            if jpeg:
                sent = self.api("sendPhoto", {"chat_id": chat, "caption": text[:1024], "parse_mode": "HTML",
                                              "disable_notification": quiet},
                                ("photo", "camera.jpg", jpeg, "image/jpeg"), timeout=timeout)
            else:
                sent = self.api("sendMessage", {"chat_id": chat, "text": text[:4096], "parse_mode": "HTML",
                                                "disable_notification": quiet, "disable_web_page_preview": True},
                                timeout=timeout)
            return "", (sent or {}).get("message_id")
        except RuntimeError as e:
            log_notify.warning("sending to Telegram failed: %s", e)
            return str(e), None

    def system(self, text, now=False):
        """A message about the app or the Pi (started, updated, shutting down), when Settings allow.
        now: send it before returning, briefly (the Pi is about to go down); otherwise in the
        background, trying again for a few minutes (just after a boot the network may not be up)."""
        send, quiet = notify_rule("system")
        if not self.configured() or not send:
            return
        if now:
            err = self.send(text, quiet=quiet, timeout=5)
            if err:
                log_notify.warning("not sent before stopping: %s", err)
            return

        def retry():
            for attempt in range(18):
                err = self.send(text, quiet=quiet)
                if not err or "cannot reach" not in err:
                    return
                time.sleep(10)
            log_notify.warning("gave up sending: %s", text)
        threading.Thread(target=retry, name="telegram-system", daemon=True).start()

    def _send_file(self, method, field, path, caption, quiet=False):
        if os.path.getsize(path) > TELEGRAM_MAX_UPLOAD:
            self.send(caption + "\n(The timelapse is too big for Telegram; download it from the dashboard.)", quiet=quiet)
            return
        with open(path, "rb") as f:
            data = f.read()
        ctype = "image/gif" if path.endswith(".gif") else "video/mp4"
        try:
            self.api(method, {"chat_id": SETTINGS["telegram_chat"], "caption": caption[:1024], "parse_mode": "HTML",
                              "disable_notification": quiet},
                     (field, os.path.basename(path), data, ctype), timeout=300)
        except RuntimeError as e:
            log_notify.warning("sending the timelapse failed: %s", e)
            self.send(caption)

    def connect(self):
        """Check the token (getMe) and set the bot's command menu. Called when the token changes."""
        if not SETTINGS["telegram_token"]:
            self.bot, self.error = "", ""
            return
        try:
            me = self.api("getMe")
            self.bot, self.error = me.get("username", ""), ""
            self.api("setMyCommands", {"commands": [{"command": c, "description": d} for c, d in self.COMMANDS]})
            log_notify.info("connected as @%s", self.bot)
        except RuntimeError as e:
            self.bot, self.error = "", str(e)
            log_notify.warning("Telegram: %s", e)
        self.offset = 0
        self.poll_wake.set()

    def view(self):
        with self.lock:
            chats = sorted(({"id": k, "name": v["name"], "t": v["t"]} for k, v in self.chats.items()),
                           key=lambda c: -c["t"])
        return {"token_set": bool(SETTINGS["telegram_token"]), "chat": SETTINGS["telegram_chat"],
                "bot": self.bot, "error": self.error, "chats": chats}

    def test(self):
        if not SETTINGS["telegram_token"]:
            return {"ok": False, "message": "enter the bot token first"}
        if not SETTINGS["telegram_chat"]:
            return {"ok": False, "message": "choose the chat first: send /start to your bot, then Refresh"}
        error = self.send("\U0001f44b Test from <b>%s</b>. Messages about jobs will arrive here.\n\n%s" % (
            _html(SETTINGS["name"]), status_text()), photo=SETTINGS["notify_photos"])
        return {"ok": not error, "message": error or "Sent - look in Telegram"}

    # ----- commands from the chat: reading only -----

    def _poll(self):
        while True:
            if not SETTINGS["telegram_token"]:
                self.poll_wake.wait(60)
                self.poll_wake.clear()
                continue
            if not self.bot and not self.error:
                self.connect()
            try:
                updates = self.api("getUpdates", {"offset": self.offset, "timeout": TELEGRAM_POLL,
                                                  "allowed_updates": ["message"]}, timeout=TELEGRAM_POLL + 15)
            except RuntimeError as e:
                if str(e) != self.error:
                    log_notify.warning("Telegram: %s", e)
                self.error = str(e)
                self.poll_wake.wait(30)
                self.poll_wake.clear()
                continue
            if self.error and self.bot:
                self.error = ""
            for u in updates or []:
                self.offset = max(self.offset, u.get("update_id", 0) + 1)
                try:
                    self._command(u.get("message") or {})
                except Exception:
                    log_notify.exception("answering a Telegram message failed")

    def _command(self, msg):
        chat = msg.get("chat") or {}
        if "id" not in chat:
            return
        cid = str(chat["id"])
        name = chat.get("title") or " ".join(filter(None, (chat.get("first_name"), chat.get("last_name")))) \
            or chat.get("username") or cid
        with self.lock:
            self.chats[cid] = {"name": name, "t": time.time()}
            for old in sorted(self.chats, key=lambda k: self.chats[k]["t"])[:-10]:
                del self.chats[old]
        text = (msg.get("text") or "").strip()
        if not text.startswith("/") or time.time() - msg.get("date", 0) > TELEGRAM_OLD_MESSAGE:
            return
        cmd = text.split()[0][1:].split("@")[0].lower()
        if cid != SETTINGS["telegram_chat"]:
            log_notify.info("message from chat %s (%s), which isn't the configured chat", cid, name)
            self.send("This bot reports on a CNC machine. To get its messages in this chat, enter the chat id "
                      "<code>%s</code> in the dashboard: Settings → Telegram." % cid, chat=cid)
            return
        log_notify.info("/%s from %s", cmd, name)
        if cmd == "status":
            self.send(status_text(), photo=True)
        elif cmd == "photo":
            if CAMERA and CAMERA.enabled():
                self.send("\U0001f4f7 %s" % _html(SETTINGS["name"]), photo=True)
            else:
                self.send("There is no camera on this machine.")
        else:
            self.send("This bot reports on <b>%s</b>: jobs starting and ending, progress, pauses and E-stop, with "
                      "camera photos and a timelapse of each job. It only reports: it can't control the machine.\n\n%s"
                      % (_html(SETTINGS["name"]), "\n".join("/%s - %s" % c for c in self.COMMANDS)))


def status_text():
    s = HUB.snapshot()[1]
    head = "<b>%s</b>" % _html(SETTINGS["name"])
    if not s["bridge_online"]:
        return head + " · OFFLINE (TNG not connected)"
    word = "E-STOP" if s.get("estop") else "PAUSED" if s.get("paused") else "RUNNING" if s.get("running") else "IDLE"
    lines = [head + " · " + word]
    if s.get("file"):
        lines.append(_html(_job_name(s["file"])))
    total = s.get("line_count") or 0
    if s.get("job") and total:
        line = s.get("line") or 0
        lines.append("Line %s of %s (%d %%)" % (line, total, 100 * line / total))
        left = s.get("time_to_end") or -1
        started = s.get("job_started")
        lines.append(" · ".join(filter(None, ("running %s" % fmt_duration(time.time() - started) if started else "",
                                                  "%s left" % fmt_duration(left) if left > 0 else ""))))
    units = "in/min" if s.get("units") == "in" else "mm/min"
    lines.append("Feed %d %s · spindle %d rpm · T%s" % (s.get("feed") or 0, units, s.get("spindle") or 0,
                                                                  s.get("tool") or "-"))
    pi = s.get("system") or {}
    if pi.get("temp") is not None:
        lines.append("Pi %.0f °C%s" % (pi["temp"], ", CPU %.0f %%" % pi["cpu"] if pi.get("cpu") is not None else ""))
    return "\n".join(line for line in lines if line)


TNG_PROFILE = os.environ.get("PCNC_PROFILE", os.path.expanduser("~/PlanetCNC/Profiles/Default"))
SERVER_STARTED = time.time()


def _file_digest(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha1(f.read()).hexdigest()
    except OSError:
        return None


def os_release():
    info = {}
    for line in _read_text("/etc/os-release").splitlines():
        k, _, v = line.partition("=")
        info[k] = v.strip().strip('"')
    return info.get("PRETTY_NAME") or platform.platform()


def system_view():
    """Everything the System window shows."""
    state = HUB.snapshot()[1]
    installed = os.path.join(TNG_PROFILE, "Scripts", "planetcnc_bridge.py")
    ours, theirs = _file_digest(os.path.join(APP_DIR, "bridge", "planetcnc_bridge.py")), _file_digest(installed)
    return {
        "host": {
            "hostname": socket.gethostname(),
            "address": lan_address(),
            "model": _read_text("/proc/device-tree/model").rstrip("\x00") or platform.machine(),
            "os": os_release(),
            "kernel": "%s %s" % (platform.release(), platform.machine()),
            "python": sys.version.split()[0],
            "uptime": (SYSTEM.latest or {}).get("uptime") if SYSTEM else None,
            "server_started": SERVER_STARTED,
        },
        "app": UPDATER.status() if UPDATER else {"git": False, "message": UPDATES_OFF_REASON},
        "bridge": {
            "online": state["bridge_online"],
            "protocol": state.get("bridge_protocol"),
            "expected": ESTOP_PROTOCOL,
            "installed": "missing" if theirs is None else "current" if theirs == ours else "different",
            "path": installed,
        },
        "os": OS_PACKAGES.status() if OS_PACKAGES else None,
        "running": bool(state.get("running")),
    }


# ---------------------------------------------------------------------------
# Home Assistant over MQTT: with MQTT discovery the machine shows up in Home Assistant as a
# device by itself, no YAML. Set up in Settings > MQTT.
#
# Topics (<base> = Settings' base topic, "planetcnc_observatory/<this Pi's host name>"):
#     <base>/status                 online / offline: the server (last will)
#     <base>/bridge                 online / offline: TNG and its bridge
#     <base>/<entity>               the current value (retained)
#     <base>/<entity>/attributes    more about it (JSON, retained)
# It only reports: nothing in Home Assistant can move, start or stop the machine.
# ---------------------------------------------------------------------------

MQTT_KEEPALIVE = 60
MQTT_TIMEOUT = 10.0
MQTT_EVERY = (1, 2, 5, 10, 30, 60, 120, 300)   # choices for the update intervals in Settings
MQTT_REFUSED = {1: "the broker doesn't speak MQTT 3.1.1", 2: "the broker refused the client id",
                3: "the broker is unavailable", 4: "wrong user name or password",
                5: "not authorised: check the user name and password"}
PROC_NET_ROUTE = "/proc/net/route"
PROC_NET_WIRELESS = "/proc/net/wireless"
SYS_NET = "/sys/class/net"


class MqttError(Exception):
    pass


class MqttClient:
    """Just enough MQTT 3.1.1 for Home Assistant, from the standard library: connect with a
    retained last will, publish (QoS 0), subscribe, keep alive. Used from one thread."""

    def __init__(self, host, port, client_id, user="", password="", will=None):
        self.buf = b""
        self.next_id = 1
        self.last_sent = self.last_recv = time.time()
        flags, payload = 0x02, self._str(client_id)          # clean session
        if will:
            flags |= 0x04 | 0x20                              # a will, retained, QoS 0
            payload += self._str(will[0]) + self._str(will[1])
        if user:
            flags |= 0x80
            payload += self._str(user)
            if password:
                flags |= 0x40
                payload += self._str(password)
        self.sock = socket.create_connection((host, port), timeout=MQTT_TIMEOUT)
        try:
            self._send(0x10, self._str("MQTT") + bytes([4, flags]) + MQTT_KEEPALIVE.to_bytes(2, "big") + payload)
            first, body = self.read()
            if first != 0x20 or len(body) < 2:
                raise MqttError("no MQTT answer: is that the broker's MQTT port?")
            if body[1]:
                raise MqttError(MQTT_REFUSED.get(body[1], "the broker refused the connection (code %d)" % body[1]))
        except socket.timeout:
            self.sock.close()
            raise MqttError("no MQTT answer: is that the broker's MQTT port?") from None
        except BaseException:
            self.sock.close()
            raise

    @staticmethod
    def _str(text):
        data = text.encode("utf-8") if isinstance(text, str) else bytes(text)
        return len(data).to_bytes(2, "big") + data

    def _send(self, first, body=b""):
        n, length = len(body), bytearray()
        while True:
            n, digit = n >> 7, n & 0x7F
            length.append(digit | (0x80 if n else 0))
            if not n:
                break
        self.sock.sendall(bytes([first]) + bytes(length) + body)
        self.last_sent = time.time()

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise MqttError("the broker closed the connection")
            self.buf += chunk
        data, self.buf = self.buf[:n], self.buf[n:]
        return data

    def read(self):
        """The next packet from the broker: (first byte, body)."""
        first = self._recv(1)[0]
        length = shift = 0
        while True:
            b = self._recv(1)[0]
            length |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
            if shift > 21:
                raise MqttError("garbled packet from the broker")
        body = self._recv(length)
        self.last_recv = time.time()
        return first, body

    def waiting(self, timeout):
        """Wait up to `timeout` seconds for something from the broker; True when it came."""
        return bool(self.buf) or bool(select.select([self.sock], [], [], timeout)[0])

    @staticmethod
    def parse_publish(first, body):
        """A PUBLISH packet -> (topic, payload)."""
        n = int.from_bytes(body[:2], "big")
        start = 2 + n + (2 if first & 0x06 else 0)  # QoS 1 and 2 carry a packet id
        return body[2:2 + n].decode("utf-8", "replace"), body[start:]

    def publish(self, topic, payload, retain=True):
        data = payload.encode("utf-8") if isinstance(payload, str) else payload
        self._send(0x30 | (1 if retain else 0), self._str(topic) + data)

    def subscribe(self, topic):
        pid, self.next_id = self.next_id, self.next_id % 65535 + 1
        self._send(0x82, pid.to_bytes(2, "big") + self._str(topic) + b"\x00")

    def keep_alive(self):
        if time.time() - self.last_recv > MQTT_KEEPALIVE * 1.5:
            raise MqttError("no answer from the broker for %d s" % (MQTT_KEEPALIVE * 1.5))
        if time.time() - self.last_sent >= MQTT_KEEPALIVE / 2:
            self._send(0xC0)  # PINGREQ

    def close(self, clean=True):
        """clean=False drops the connection, so the broker sends the last will."""
        try:
            if clean:
                self._send(0xE0)  # DISCONNECT
        except OSError:
            pass
        self.sock.close()


# The comment block an adjusted file starts with (see web/tune.js): not an operation name.
TUNE_HEADER_START = "(--- Feeds and steps adjusted on the CNC dashboard"
TUNE_HEADER_END = "(--- end of adjustments ---)"
GCODE_WORD = re.compile(r"([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))")


def program_operations(text):
    """The operations of a program, read as the Feeds & steps window does (web/tune.js): CAM
    programs such as Fusion write each operation's name, e.g. (2D Adaptive1), on a comment line
    before it. An operation starts at a comment line once the previous one has moved; of
    several comment lines before the first move, the last one names it. Operations that don't
    cut (setup, the end of the program) are left out.
    Returns [(first line, name)], line numbers from 1 as the dashboard counts them."""
    lines = text.splitlines()
    skip = range(0)
    start = next((i for i, l in enumerate(lines[:400]) if l.strip().startswith(TUNE_HEADER_START)), None)
    if start is not None:
        end = next((i for i in range(start, min(len(lines), 400)) if lines[i].strip() == TUNE_HEADER_END), None)
        if end is not None:
            skip = range(start, end + 1)
    ops, op, moved, motion = [], None, True, 0
    for i, line in enumerate(lines):
        if i in skip:
            continue
        comments = [c.strip() for c in re.findall(r"\(([^)]*)\)", line)]
        code = re.sub(r"\([^)]*\)", " ", line)
        if ";" in code:
            code, _, rest = code.partition(";")
            comments.append(rest.strip())
        words = GCODE_WORD.findall(code.upper())
        if not words and any(comments) and not any(
                re.match(r"T\d+\s+D=", c, re.I) or re.match(r"(extra|original) pass ", c, re.I) for c in comments):
            name = " ".join(" ".join(c for c in comments if c).replace("(", " ").replace(")", " ").split())
            if moved:
                op = {"line": i + 1, "name": name or "Operation %d" % (len(ops) + 1), "cuts": False}
                ops.append(op)
                moved = False
            elif name:
                op["name"], op["line"] = name, i + 1   # it starts at the comment that names it
            continue
        if op is None:
            op = {"line": i + 1, "name": "Operation 1", "cuts": False}
            ops.append(op)
        homing = False
        for letter, value in words:
            if letter != "G":
                continue
            g = round(float(value) * 10)
            if g in (0, 10, 20, 30) or (730 <= g <= 890 and g % 10 == 0):
                motion = g // 10
            elif g in (280, 300, 530):   # G28 / G30 home, G53 machine coordinates: not part of the cut
                homing = True
        if homing or not any(letter in "XYZ" for letter, _ in words):
            continue
        moved = True
        if motion:
            op["cuts"] = True
    return [(o["line"], o["name"]) for o in ops if o["cuts"]]


def network_info():
    """The network the Pi reaches the home network through (its default route): interface,
    address, MAC and, on WiFi, network name, signal and link details."""
    info = {"interface": None, "ip": None, "mac": None, "ssid": None, "wifi_dbm": None, "wifi_quality": None,
            "wifi_freq": None, "wifi_bitrate": None}
    best = None
    for line in _read_text(PROC_NET_ROUTE).splitlines()[1:]:
        f = line.split()  # Iface Destination Gateway Flags RefCnt Use Metric ...
        try:
            if len(f) >= 7 and f[1] == "00000000" and int(f[3], 16) & 1 and (best is None or int(f[6]) < best[0]):
                best = int(f[6]), f[0]
        except ValueError:
            continue
    address = lan_address()
    info["ip"] = None if address == "localhost" else address
    if not best:
        return info
    iface = info["interface"] = best[1]
    info["mac"] = _read_text(os.path.join(SYS_NET, iface, "address")).strip() or None
    for line in _read_text(PROC_NET_WIRELESS).splitlines()[2:]:
        name, _, rest = line.partition(":")
        if name.strip() == iface:
            try:
                dbm = float(rest.split()[2].rstrip("."))  # status, link, level (dBm), noise
            except (ValueError, IndexError):
                break
            info["wifi_dbm"] = round(dbm)
            # -100 dBm and below = 0 %, -50 dBm and above = 100 %, as most systems show it.
            info["wifi_quality"] = max(0, min(100, round(2 * (dbm + 100))))
    if info["wifi_dbm"] is not None:
        iw = shutil.which("iw", path=os.environ.get("PATH", "") + os.pathsep + "/usr/sbin:/sbin")
        if iw:
            try:
                out = subprocess.run([iw, "dev", iface, "link"], capture_output=True, text=True, timeout=3).stdout
            except (OSError, subprocess.SubprocessError):
                out = ""
            for key, pattern in (("ssid", r"^\s*SSID:\s*(.+)$"), ("wifi_freq", r"^\s*freq:\s*([\d.]+)"),
                                 ("wifi_bitrate", r"^\s*tx bitrate:\s*([\d.]+)")):
                m = re.search(pattern, out, re.M)
                if m:
                    info[key] = m.group(1).strip() if key == "ssid" else float(m.group(1))
    return info


def power_text(t):
    """vcgencmd get_throttled flags in words, as the menu's lightning mark says them (web/nav.js)."""
    if t is None:
        return None
    return ("Under-voltage!" if t & 0x1 else "Throttled" if t & 0x6 else "Temperature limit" if t & 0x8
            else "Under-voltage since boot" if t & 0x10000 else "Throttled since boot" if t & 0xE0000
            else "Power OK")


def boot_time():
    for line in _read_text(PROC_STAT).splitlines():
        if line.startswith("btime "):
            try:
                return int(line.split()[1])
            except (ValueError, IndexError):
                break
    up = ((SYSTEM.latest if SYSTEM else None) or {}).get("uptime")
    return None if up is None else int((time.time() - up) // 60 * 60)


def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(t))


def _r(v, digits=1):
    return None if v is None else round(v, digits) if digits else int(round(v))


STATUS_WORDS = ["Offline", "Idle", "Running", "Paused", "E-stop"]


class HaEntity:
    """One Home Assistant entity. group: "now" = sent as soon as it changes, "machine" = at
    most every Settings' machine interval, "system" = every system interval."""

    def __init__(self, key, component, name, icon, group, machine=False, **extra):
        self.key, self.component, self.name, self.icon, self.group = key, component, name, icon, group
        self.machine = machine     # unavailable while TNG (the bridge) is offline
        self.extra = extra


def _sensor(key, name, icon, group, unit=None, device_class=None, state_class="measurement", **kw):
    extra = dict(kw)
    if unit:
        extra.update(unit_of_measurement=unit, state_class=state_class)
    if device_class:
        extra["device_class"] = device_class
    return HaEntity(key, "sensor", name, icon, group, **extra)


HA_ENTITIES = [
    # The machine
    _sensor("status", "Status", "mdi:state-machine", "now", device_class="enum", options=STATUS_WORDS),
    HaEntity("job", "binary_sensor", "Job running", "mdi:play-circle-outline", "now", machine=True,
             device_class="running", payload_on="ON", payload_off="OFF"),
    _sensor("program", "Program", "mdi:file-code-outline", "now", machine=True),
    _sensor("operation", "Operation", "mdi:cog-play-outline", "now", machine=True),
    _sensor("progress", "Progress", "mdi:progress-clock", "machine", "%", machine=True, suggested_display_precision=0),
    _sensor("operation_progress", "Operation progress", "mdi:progress-wrench", "machine", "%", machine=True,
            suggested_display_precision=0),
    _sensor("time_left", "Time left", "mdi:timer-sand", "machine", "min", "duration", machine=True,
            suggested_display_precision=0),
    _sensor("job_time", "Job time", "mdi:timer-outline", "machine", "min", "duration", machine=True,
            suggested_display_precision=0),
    _sensor("tool", "Tool", "mdi:screwdriver", "now", machine=True),
    _sensor("spindle", "Spindle speed", "mdi:fan", "machine", "rpm", machine=True, suggested_display_precision=0),
    # No device class: Home Assistant's "speed" doesn't take mm/min.
    _sensor("feed", "Feed rate", "mdi:speedometer", "machine", "mm/min", machine=True, suggested_display_precision=0),
    # The Raspberry Pi, as the rings at the bottom of the menu, and its network
    _sensor("cpu_use", "CPU use", "mdi:cpu-64-bit", "system", "%", entity_category="diagnostic",
            suggested_display_precision=0),
    _sensor("ram_use", "RAM use", "mdi:memory", "system", "%", entity_category="diagnostic",
            suggested_display_precision=0),
    _sensor("cpu_temperature", "CPU temperature", "mdi:thermometer", "system", "°C", "temperature",
            entity_category="diagnostic", suggested_display_precision=0),
    _sensor("disk_use", "Disk use", "mdi:harddisk", "system", "%", entity_category="diagnostic",
            suggested_display_precision=0),
    _sensor("power", "Power", "mdi:flash", "system", entity_category="diagnostic"),
    _sensor("last_boot", "Last boot", "mdi:clock-start", "system", device_class="timestamp",
            entity_category="diagnostic"),
    _sensor("ip_address", "IP address", "mdi:ip-network", "system", entity_category="diagnostic"),
    _sensor("mac_address", "MAC address", "mdi:network-outline", "system", entity_category="diagnostic"),
    _sensor("wifi_network", "WiFi network", "mdi:wifi-settings", "system", entity_category="diagnostic"),
    _sensor("wifi_signal", "WiFi signal", "mdi:wifi", "system", "dBm", "signal_strength",
            entity_category="diagnostic"),
    _sensor("wifi_quality", "WiFi quality", "mdi:wifi-strength-3", "system", "%", entity_category="diagnostic"),
]


class HomeAssistant:
    """Publishes the machine and the Pi to Home Assistant through an MQTT broker (Settings > MQTT).
    One thread: connects, announces the entities (MQTT discovery), then once a second sends
    what changed, each value no more often than its group's interval allows."""

    def __init__(self, http_port):
        self.node = re.sub(r"[^a-z0-9]+", "_", socket.gethostname().lower()).strip("_") or "planetcnc"
        self.http_port = http_port
        self.wake = threading.Event()
        self.restart = False          # the settings changed: reconnect with the new ones
        self.connected = False
        self.error = ""
        self.base = ""
        self.announced = None         # (device name, base, prefix) the discovery was sent with
        self.sent = {}                # entity key -> (state, attributes json, time sent)
        self.bridge_sent = None
        self.ops = ("", [], [], 0)   # (program id, program_operations(), their first lines, line count)
        self.network = ({}, 0.0)      # (network_info(), when)
        threading.Thread(target=self._run, name="mqtt", daemon=True).start()

    # ----- settings -----

    @staticmethod
    def enabled():
        return bool(SETTINGS["mqtt_enabled"] and SETTINGS["mqtt_host"])

    def default_base(self):
        return "planetcnc_observatory/" + self.node

    def base_topic(self):
        return (SETTINGS["mqtt_base"] or self.default_base()).strip("/")

    def settings_changed(self):
        self.restart = True
        self.wake.set()

    def view(self):
        return {"enabled": bool(SETTINGS["mqtt_enabled"]), "host": SETTINGS["mqtt_host"], "port": SETTINGS["mqtt_port"],
                "user": SETTINGS["mqtt_user"], "password_set": bool(SETTINGS["mqtt_password"]),
                "prefix": SETTINGS["mqtt_prefix"], "base": SETTINGS["mqtt_base"], "base_default": self.default_base(),
                "machine_every": SETTINGS["mqtt_machine_every"], "system_every": SETTINGS["mqtt_system_every"],
                "every_choices": list(MQTT_EVERY), "connected": self.connected, "error": self.error,
                "entities": len(HA_ENTITIES)}

    # ----- the connection -----

    def _run(self):
        backoff = 5
        while True:
            self.restart = False
            if not self.enabled():
                self.connected, self.error = False, ""
                self.wake.wait()
                self.wake.clear()
                continue
            try:
                self._session()
                backoff = 5
            except (OSError, MqttError) as e:
                error = str(e) or e.__class__.__name__
                if isinstance(e, socket.gaierror):
                    error = "unknown broker address %s" % SETTINGS["mqtt_host"]
                elif isinstance(e, ConnectionRefusedError):
                    error = "nothing answers on %s port %s" % (SETTINGS["mqtt_host"], SETTINGS["mqtt_port"])
                if self.connected:
                    HUB.log("warn", "Home Assistant: MQTT connection lost (%s)" % error)
                if error != self.error:
                    log_mqtt.warning("%s; trying again in %d s", error, backoff)
                self.connected, self.error = False, error
            except Exception:  # noqa: BLE001 - keep trying whatever happens
                log_mqtt.exception("unexpected error")
                self.connected, self.error = False, "unexpected error, see the log"
            if self.restart:
                continue
            self.wake.wait(backoff)
            self.wake.clear()
            backoff = min(backoff * 2, 300)

    def _session(self):
        self.base = self.base_topic()
        status = self.base + "/status"
        ha_status = SETTINGS["mqtt_prefix"].strip("/") + "/status"
        client = MqttClient(SETTINGS["mqtt_host"], int(SETTINGS["mqtt_port"]), "planetcnc_observatory_" + self.node,
                            SETTINGS["mqtt_user"], SETTINGS["mqtt_password"], will=(status, "offline"))
        try:
            log_mqtt.info("connected to %s:%s, topics %s/...", SETTINGS["mqtt_host"], SETTINGS["mqtt_port"], self.base)
            HUB.log("ok", "Home Assistant: connected to the MQTT broker %s" % SETTINGS["mqtt_host"])
            self.connected, self.error = True, ""
            client.subscribe(ha_status)
            self._announce(client)
            while not self.restart:
                if client.waiting(1.0):
                    first, body = client.read()
                    if first & 0xF0 == 0x30:
                        topic, payload = MqttClient.parse_publish(first, body)
                        if topic == ha_status and payload.strip() == b"online":
                            log_mqtt.info("Home Assistant (re)started: announcing again")
                            self._announce(client)
                    continue
                client.keep_alive()
                self._publish(client)
            client.publish(status, "offline")   # stopping cleanly: the broker only sends the will on a lost connection
            client.close()
            self.connected = False
            log_mqtt.info("disconnected (settings changed)")
        except BaseException:
            client.close(clean=False)
            raise

    # ----- what Home Assistant gets -----

    def _device(self):
        return {"identifiers": ["planetcnc_observatory_" + self.node], "name": SETTINGS["name"],
                "manufacturer": "PlanetCNC Observatory", "model": "PlanetCNC TNG machine",
                "sw_version": CONFIG.version or "unknown",
                "configuration_url": "http://%s:%d/" % (lan_address(), self.http_port)}

    def _announce(self, client):
        """Send the discovery configs, then every value (Home Assistant may have just started)."""
        prefix = SETTINGS["mqtt_prefix"].strip("/")
        device = self._device()
        for e in HA_ENTITIES:
            topic = "%s/%s" % (self.base, e.key)
            config = {"name": e.name, "unique_id": "planetcnc_observatory_%s_%s" % (self.node, e.key),
                      "icon": e.icon, "state_topic": topic, "device": device,
                      "availability": [{"topic": self.base + "/status"}]}
            if e.machine:
                config["availability"].append({"topic": self.base + "/bridge"})
                config["availability_mode"] = "all"
            if e.component == "sensor":
                config["json_attributes_topic"] = topic + "/attributes"
            config.update(e.extra)
            client.publish("%s/%s/%s/%s/config" % (prefix, e.component, self.node, e.key), json.dumps(config))
        client.publish(self.base + "/status", "online")
        self.announced = (SETTINGS["name"], self.base, prefix)
        self.sent, self.bridge_sent = {}, None
        self._publish(client)

    def _publish(self, client):
        if self.announced[0] != SETTINGS["name"]:   # the machine was renamed: tell Home Assistant
            self._announce(client)
            return
        now = time.time()
        every = {"now": 0, "machine": SETTINGS["mqtt_machine_every"], "system": SETTINGS["mqtt_system_every"]}
        values, bridge = self._values(now)
        if bridge != self.bridge_sent:
            client.publish(self.base + "/bridge", bridge)
            self.bridge_sent = bridge
        for e in HA_ENTITIES:
            if e.key not in values:
                continue
            state, attrs = values[e.key]
            payload = "None" if state is None else state if isinstance(state, str) else json.dumps(state)
            attrs = json.dumps(attrs, sort_keys=True) if attrs is not None else None
            last = self.sent.get(e.key)
            if last and (last[:2] == (payload, attrs) or now - last[2] < every[e.group] - 0.5):
                continue
            if attrs is not None and (not last or last[1] != attrs):
                client.publish("%s/%s/attributes" % (self.base, e.key), attrs)
            client.publish("%s/%s" % (self.base, e.key), payload)
            self.sent[e.key] = (payload, attrs, now)

    def operation(self, line):
        """(number, count, name, first line, first line of the next one) of the operation the
        program is at, or None."""
        with HUB.cond:
            pid, text = HUB.program["id"], HUB.program["text"]
        if self.ops[0] != pid:  # read each program once
            ops = program_operations(text)
            self.ops = (pid, ops, [o[0] for o in ops], text.count("\n") + 1)
        _, ops, starts, count = self.ops
        k = bisect.bisect_right(starts, line) - 1
        if k < 0:
            return None
        end = starts[k + 1] if k + 1 < len(ops) else count + 1
        return k + 1, len(ops), ops[k][1], ops[k][0], end

    def _values(self, now):
        """{entity key: (state, attributes)} and the bridge's availability."""
        _, s = HUB.snapshot()
        online, job = s["bridge_online"], bool(s.get("job"))
        status = ("Offline" if not online else "E-stop" if s.get("estop") else "Paused" if s.get("paused")
                  else "Running" if s.get("running") else "Idle")
        line, total = int(s.get("line") or 0), int(s.get("line_count") or 0)
        op = self.operation(line) if job and total else None
        left = s.get("time_to_end")
        inch = 25.4 if s.get("units") == "in" else 1.0
        tool = int(s.get("tool") or 0)
        v = {
            "status": (status, None),
            "job": ("ON" if job else "OFF", None),
            "program": (_job_name(s["file"]) if s.get("file") else None, {"path": s.get("file") or ""}),
            "operation": (op[2] if op else None,
                          {"number": op[0], "count": op[1], "first_line": op[3]} if op else {}),
            "progress": (_r(100.0 * line / total) if job and total else None,
                         {"line": line, "line_count": total} if job and total else {}),
            "operation_progress": (_r(max(0.0, min(100.0, 100.0 * (line - op[3]) / max(1, op[4] - op[3]))))
                                   if op else None, None),
            "time_left": (_r(left / 60.0) if job and left is not None and left >= 0 else None, None),
            "job_time": (_r((now - s["job_started"]) / 60.0) if job and s.get("job_started") else None, None),
            "tool": (("T%d" % tool + (" " + s["tool_name"] if s.get("tool_name") else "")) if tool else None,
                     {"number": tool, "diameter": s.get("tool_diameter") or None}),
            "spindle": (_r(s.get("spindle") or 0, 0), None),
            "feed": (_r((s.get("feed") or 0) * inch, 0), None),
        }
        sys_ = (SYSTEM.latest if SYSTEM else None) or {}
        net, when = self.network
        if now - when >= max(5, SETTINGS["mqtt_system_every"] - 1):
            try:
                net = network_info()
            except Exception:  # noqa: BLE001 - leave the network sensors as they were
                log_mqtt.exception("reading the network details failed")
            self.network = (net, now)
        pct = lambda used, total: _r(100.0 * sys_[used] / sys_[total]) if sys_.get(total) else None  # noqa: E731
        boot = boot_time()
        v.update({
            "cpu_use": (_r(sys_.get("cpu")), None),
            "ram_use": (pct("mem_used", "mem_total"), {"total_mb": int(sys_["mem_total"] / 2**20)} if sys_.get("mem_total") else {}),
            "cpu_temperature": (_r(sys_.get("temp")), None),
            "disk_use": (pct("disk_used", "disk_total"),
                         {"total_gb": round(sys_["disk_total"] / 2**30, 1)} if sys_.get("disk_total") else {}),
            "power": (power_text(sys_.get("throttled")),
                      {"throttled": "0x%x" % sys_["throttled"]} if sys_.get("throttled") is not None else {}),
            "last_boot": (_iso(boot) if boot else None, None),
            "ip_address": (net.get("ip"), {"interface": net.get("interface")}),
            "mac_address": (net.get("mac"), {"interface": net.get("interface")}),
            "wifi_network": (net.get("ssid"), None),
            "wifi_signal": (net.get("wifi_dbm"), {k: net.get("wifi_" + k) for k in ("freq", "bitrate")
                                                  if net.get("wifi_" + k) is not None}),
            "wifi_quality": (net.get("wifi_quality"), None),
        })
        return v, "online" if online else "offline"


# ---------------------------------------------------------------------------
# Settings changed from the dashboard, kept in settings.json next to this file
# ---------------------------------------------------------------------------

SETTINGS_FILE = os.path.join(APP_DIR, "settings.json")
TUNING_FILE = os.path.join(APP_DIR, "tuning.json")   # the feeds log, see TuningLog
PRESETS_FILE = os.path.join(APP_DIR, "planing_presets.json")   # material presets of the /planing page
BITS_FILE = os.path.join(APP_DIR, "planing_bits.json")         # planing bits of the /planing page
SENT_DIR = os.path.join(APP_DIR, "sent")    # programs loaded in TNG without being saved (/api/tng/send)
MAX_SEND_BYTES = 20 * 2**20
DEFAULT_NAME = "PlanetCNC"
OLD_DEFAULT_NAMES = ("CNC Monitor",)   # earlier defaults, saved in settings.json: shown as the new one
MAX_NAME_LENGTH = 40
# camera / files_dir None: what --camera / --files-dir say
# Which CAM program wrote the G-code, for reading the tool sizes from its comments (see gcode.js).
TOOL_CAMS = {"fusion": "Fusion 360"}

SETTINGS = {"name": DEFAULT_NAME, "camera": None, "camera_view": True, "log_debug": False, "files_dir": None,
            "tool_shape": True, "tool_cam": "fusion",
            # Telegram notifications and the job timelapse (see Notifier, Timelapse)
            "telegram_token": "", "telegram_chat": "", "notify_progress": 10, "notify_minutes": 0,
            "notify_photos": True, "notify_replace": True,
            "notify_events": {},   # per message kind: {"send": bool, "silent": bool}, where it differs from NOTIFY_EVENTS
            "timelapse": True, "timelapse_interval": 10,
            # Home Assistant over MQTT (see HomeAssistant); mqtt_base "" = planetcnc_observatory/<host name>
            "mqtt_enabled": False, "mqtt_host": "", "mqtt_port": 1883, "mqtt_user": "", "mqtt_password": "",
            "mqtt_prefix": "homeassistant", "mqtt_base": "", "mqtt_machine_every": 5, "mqtt_system_every": 30}
NOTIFY_PROGRESS_STEPS = (0, 5, 10, 20, 25, 50)
NOTIFY_MINUTES = (0, 5, 10, 15, 30, 60)   # progress message at least this often (0 = only by percentage)
TIMELAPSE_INTERVALS = (5, 10, 20, 30, 60)
SETTINGS_LOCK = threading.Lock()
# The Telegram messages, in the order Settings shows them: (kind, label, silent by default).
# All are sent by default. A silent message arrives without sound or vibration.
NOTIFY_EVENTS = (
    ("job_start", "Job started", False),
    ("progress", "Progress", True),
    ("paused", "Paused", False),
    ("resumed", "Resumed", True),
    ("estop", "E-stop", False),
    ("job_end", "Job finished or stopped", False),
    ("bridge_lost", "TNG not reachable during a job", False),
    ("pi", "Raspberry Pi warnings (under-voltage, heat)", False),
    ("system", "Updates, start-up and shut-down of the Pi", False),
)


def notify_rule(kind):
    """(send, silent) for a kind of Telegram message, from Settings."""
    default = next((silent for k, _, silent in NOTIFY_EVENTS if k == kind), False)
    rule = (SETTINGS["notify_events"] or {}).get(kind) or {}
    return bool(rule.get("send", True)), bool(rule.get("silent", default))


def load_settings():
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            saved = json.load(f)
    except FileNotFoundError:
        return
    except (OSError, ValueError) as e:
        LOG.warning("cannot read %s: %s - using default settings", SETTINGS_FILE, e)
        return
    if isinstance(saved, dict):
        SETTINGS.update({k: v for k, v in saved.items() if k in SETTINGS})
        if "notify_events" not in saved:  # from before the per-message settings: keep what was chosen
            SETTINGS["notify_events"] = {kind: {"send": False} for kind, old in (("pi", "notify_pi"), ("system", "notify_system"))
                                         if saved.get(old) is False}
    if not isinstance(SETTINGS["notify_events"], dict):
        SETTINGS["notify_events"] = {}
    if SETTINGS["name"] in OLD_DEFAULT_NAMES:
        SETTINGS["name"] = DEFAULT_NAME


def save_settings(changes):
    with SETTINGS_LOCK:
        SETTINGS.update(changes)
        tmp = SETTINGS_FILE + ".tmp"
        # Only this user may read it: it holds the Telegram bot token and the MQTT password.
        with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
            json.dump(SETTINGS, f, indent=2)
        try:
            os.chmod(tmp, 0o600)  # also when the file existed with wider rights
        except OSError:
            pass
        os.replace(tmp, SETTINGS_FILE)


def apply_files_dir():
    """Use the folder chosen in Settings, or --files-dir if none is chosen or it is gone."""
    choice = SETTINGS["files_dir"]
    if choice and os.path.isdir(choice):
        CONFIG.files_dir = os.path.realpath(choice)
    else:
        if choice:
            log_files.warning("folder %s (from Settings) not found, using %s", choice, CONFIG.files_default or "none")
        CONFIG.files_dir = CONFIG.files_default
    if CONFIG.files_dir:
        log_files.info("folder %s", CONFIG.files_dir)


def norm_path(p):
    """A file path as TNG or this server writes it, made comparable (TNG writes //home/...)."""
    if not p:
        return ""
    if p.startswith("//") and os.sep == "/":
        p = "/" + p.lstrip("/")
    return os.path.normcase(os.path.realpath(p))


def files_rel(p):
    """Path of `p` inside the Files folder, or "" when it's elsewhere."""
    if not p or not CONFIG.files_dir:
        return ""
    full, root = norm_path(p), norm_path(CONFIG.files_dir)
    if not full.startswith(root + os.sep):
        return ""
    return os.path.relpath(full, root).replace(os.sep, "/")


class TuningLog:
    """Feeds and steps changed in the dashboard's Feeds & steps window: one entry per saved file,
    with how each job with that file went. Kept in tuning.json next to this file, so the values
    that worked can be copied back into the CAM program later."""

    MAX_ENTRIES = 500
    STATUSES = ("", "good", "bad")

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.entries = []
        self.seq = 0
        self.job = None   # (entry id, start time) while a job with an adjusted file runs
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            self.entries = [e for e in data.get("entries", []) if isinstance(e, dict) and e.get("id")]
        except FileNotFoundError:
            pass
        except (OSError, ValueError, AttributeError) as e:
            log_files.warning("cannot read %s: %s - starting an empty feeds log", path, e)

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"entries": self.entries}, f, indent=1)
        os.replace(tmp, self.path)
        self.seq += 1

    def list(self):
        with self.lock:
            return [dict(e) for e in self.entries], self.seq

    def add(self, entry):
        with self.lock:
            entry["id"] = "%x" % int(time.time() * 1000)
            while any(e["id"] == entry["id"] for e in self.entries):
                entry["id"] += "x"
            self.entries.append(entry)
            del self.entries[:-self.MAX_ENTRIES]
            self._save()
            return entry

    def update(self, entry_id, changes):
        with self.lock:
            for e in self.entries:
                if e["id"] == entry_id:
                    e.update(changes)
                    self._save()
                    return dict(e)
        return None

    def delete(self, entry_id):
        with self.lock:
            n = len(self.entries)
            self.entries = [e for e in self.entries if e["id"] != entry_id]
            if len(self.entries) == n:
                return False
            self._save()
            return True

    def job_started(self, path):
        key = norm_path(path) if path else None
        self.job = None
        with self.lock:
            for e in reversed(self.entries):
                if key and e.get("abs") and norm_path(e["abs"]) == key:
                    self.job = (e["id"], time.time())
                    break

    def job_ended(self, line, line_count):
        """Record how the job went; returns the file name when it was an adjusted file."""
        if not self.job:
            return None
        entry_id, started = self.job
        self.job = None
        run = {"start": started, "end": time.time(), "line": line, "lines": line_count,
               "done": bool(line_count) and line >= line_count - 2}
        with self.lock:
            for e in self.entries:
                if e["id"] == entry_id:
                    e.setdefault("runs", []).append(run)
                    del e["runs"][:-20]
                    try:
                        self._save()
                    except OSError as err:
                        log_files.error("cannot save the feeds log: %s", err)
                    return e.get("name", "")
        return None


class PlaningPresets:
    """Named values for the /planing page, kept in a JSON file next to this file so every device
    sees the same ones: the cutting values per material (oak, cherry...) in planing_presets.json,
    and the planing bits (their diameter) in planing_bits.json."""

    MAX_PRESETS = 100
    MAX_NAME = 40

    def __init__(self, path, keys=("rpm", "feed", "plunge", "stepdown", "stepover"), what="material",
                 what_plural="materials"):
        self.path, self.keys, self.what, self.what_plural = path, keys, what, what_plural
        self.lock = threading.Lock()
        self.presets = {}
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f).get("presets", {})
            self.presets = {str(k): v for k, v in data.items() if isinstance(v, dict)}
        except FileNotFoundError:
            pass
        except (OSError, ValueError, AttributeError) as e:
            log_files.warning("cannot read %s: %s - starting without planing %s", path, e, what_plural)

    def list(self):
        with self.lock:
            return {k: dict(v) for k, v in self.presets.items()}

    def clean(self, name, values):
        """(name, values) checked, or raises ValueError with a message for the page."""
        name = " ".join(str(name or "").split())
        if not name or len(name) > self.MAX_NAME:
            raise ValueError("a %s name of 1 to %d characters is needed" % (self.what, self.MAX_NAME))
        if not isinstance(values, dict):
            raise ValueError("invalid values")
        out = {}
        for k in self.keys:
            v = values.get(k)
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
                raise ValueError("invalid value for %s" % k)
            out[k] = v
        return name, out

    def save(self, name, values):
        with self.lock:
            # A name that differs only in case replaces the existing one (Oak = oak)
            for k in list(self.presets):
                if k.lower() == name.lower():
                    del self.presets[k]
            if len(self.presets) >= self.MAX_PRESETS:
                raise ValueError("at most %d %s" % (self.MAX_PRESETS, self.what_plural))
            self.presets[name] = values
            self._write()

    def delete(self, name):
        with self.lock:
            if name not in self.presets:
                return False
            del self.presets[name]
            self._write()
            return True

    def _write(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"presets": self.presets}, f, indent=1, sort_keys=True)
        os.replace(tmp, self.path)


HUB = Hub()
TUNING = None
PRESETS = None
BITS = None
CAMERA = None
SYSTEM = None
UPDATER = None
OS_PACKAGES = None
NOTIFY = None
TIMELAPSE = None
HA = None
REJECTED_BRIDGES = set()  # addresses already reported for a wrong token
CLIENT_LOG_RATE = {}      # browser address -> (minute started, lines received), for CLIENT_LOG_LIMIT
CLIENT_LOG_LOCK = threading.Lock()
CONFIG = argparse.Namespace(token="", files_dir="", files_default="", line_offset=0, camera_note="", version="")


class Handler(BaseHTTPRequestHandler):
    server_version = "PlanetCNCWeb/1.0"
    protocol_version = "HTTP/1.1"

    def log_request(self, code="-", size="-"):
        if self.command == "POST" and self.path == "/api/state":
            return  # the bridge posts 5 times a second
        log_http.debug("%s %s -> %s", self.client_address[0], self.requestline, code)

    def log_error(self, fmt, *args):
        log_http.warning("%s: %s", self.client_address[0], fmt % args)

    def parse_request(self):
        self._started = time.time()
        return super().parse_request()

    def handle_one_request(self):
        self._started = None
        super().handle_one_request()
        if self._started:
            took = time.time() - self._started
            path = urlparse(getattr(self, "path", "")).path
            if took > SLOW_REQUEST and path not in ("/api/events", "/api/camera.mjpg", "/api/camera.jpg", "/api/tng/call",
                                                     "/api/estop", "/api/tng/open", "/api/tng/send",
                                                     "/api/update/check", "/api/update/apply", "/api/update/rollback",
                                                     "/api/system/os/check"):
                log_http.warning("slow request: %s %s from %s took %.1f s", self.command, path,
                                 self.client_address[0], took)

    # ---------- helpers ----------

    def _send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        extra = dict(extra or {})
        self.send_header("Cache-Control", extra.pop("Cache-Control", "no-store"))
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj))

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _bridge_authorized(self):
        if not CONFIG.token:
            # The bridge receives machine commands, so without a token only TNG on this machine may act as one.
            return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")
        return hmac.compare_digest(self.headers.get("X-Bridge-Token", ""), CONFIG.token)

    # ---------- routes ----------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            self._json(200, HUB.snapshot()[1])
        elif path == "/api/program":
            with HUB.cond:
                prog = dict(HUB.program)
            self._json(200, prog)
        elif path == "/api/events":
            self._sse()
        elif path == "/api/camera.mjpg":
            self._camera_stream()
        elif path == "/api/camera.jpg":
            self._camera_still()
        elif path == "/api/tng/call":
            self._tng_read(self._query("f"), self._query("args"))
        elif path == "/api/tng/commands":
            self._tng_read("cmd_list", "[]")
        elif path == "/api/update":
            self._json(200, UPDATER.status() if UPDATER else {"git": False, "message": UPDATES_OFF_REASON})
        elif path == "/api/system":
            self._json(200, system_view())
        elif path == "/api/timelapses/download":
            self._timelapse_download()
        elif path == "/api/settings":
            self._json(200, self._settings_view())
        elif path == "/api/console":
            try:
                after = int(self._query("after") or 0)
            except ValueError:
                after = 0
            self._json(200, {"lines": HUB.console_since(after)})
        elif path == "/api/files":
            self._files_list()
        elif path == "/api/folders":
            self._folders()
        elif path == "/api/files/zip":
            self._files_zip()
        elif path == "/api/files/download":
            self._files_download()
        elif path == "/api/tuning":
            entries, seq = TUNING.list()
            self._json(200, {"ok": True, "entries": entries, "seq": seq})
        elif path == "/api/planing/presets":
            self._json(200, {"ok": True, "presets": PRESETS.list()})
        elif path == "/api/planing/bits":
            self._json(200, {"ok": True, "presets": BITS.list()})
        elif path == "/api/logs":
            self._logs_list()
        elif path == "/api/logs/tail":
            self._logs_tail()
        elif path == "/api/logs/download":
            self._logs_download()
        else:
            self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path in ("/api/update/check", "/api/update/apply", "/api/update/rollback"):
            self._update({"check": "check", "apply": "update", "rollback": "rollback"}[path.rsplit("/", 1)[1]])
            return
        if path == "/api/estop":
            if self._require_writer():
                self._estop()
            return
        if path == "/api/tng/open":
            if self._require_writer():
                self._tng_open()
            return
        if path == "/api/tng/send":
            if self._require_writer():
                self._tng_send()
            return
        if path == "/api/telegram/test":
            if self._require_writer():
                result = NOTIFY.test() if NOTIFY else {"ok": False, "message": "not available"}
                self._json(200 if result["ok"] else 409, result)
            return
        if path in ("/api/system/os/check", "/api/system/os/upgrade", "/api/system/power"):
            if self._require_writer():
                self._system_action(path.rsplit("/", 1)[1])
            return
        if path in ("/api/files/upload", "/api/files/delete", "/api/files/move", "/api/files/mkdir",
                    "/api/files/rename"):
            if self._require_writer():
                {"upload": self._files_upload, "delete": self._files_delete,
                 "move": self._files_move, "mkdir": self._files_mkdir,
                 "rename": self._files_rename}[path.rsplit("/", 1)[1]]()
            return
        if path == "/api/settings":
            if self._require_writer():
                self._settings_change()
            return
        if path == "/api/tuning":
            if self._require_writer():
                self._tuning_change()
            return
        if path in ("/api/planing/presets", "/api/planing/bits"):
            if self._require_writer():
                self._presets_change(PRESETS if path.endswith("presets") else BITS)
            return
        if path == "/api/log":
            if self._require_writer():
                self._client_log()
            return
        if path == "/api/logs/level":
            if self._require_writer():
                self._logs_level()
            return
        if not self._bridge_authorized():
            client = self.client_address[0]
            if client not in REJECTED_BRIDGES:
                REJECTED_BRIDGES.add(client)
                log_bridge.warning("rejected a bridge from %s: %s", client, (
                    "wrong token (TOKEN in the bridge must match --token)" if CONFIG.token else
                    "without --token only a bridge on this machine is accepted"))
            self.close_connection = True  # the request body was not read
            self._json(403, {"error": "bad token"})
            return
        try:
            data = json.loads(self._read_body() or b"{}")
        except ValueError:
            self._json(400, {"error": "invalid json"})
            return
        if path == "/api/state":
            self._bridge_log(data.pop("log", None) or [])
            HUB.add_results(data.pop("results", None) or [])
            reply = {"ok": True}
            if "values" in data:
                # Generic bridge: raw values in, dashboard state out. Send the spec when the
                # bridge doesn't have the current one (first update, or after a server update).
                state = derive_state(data["values"])
                state["bridge_protocol"] = data.get("protocol")
                if data.get("spec_id") != BRIDGE_SPEC["id"]:
                    reply["spec"] = BRIDGE_SPEC
                    log_bridge.info("sending the reading spec %s to the bridge (it had %s)",
                                    BRIDGE_SPEC["id"], data.get("spec_id"))
            else:
                state = data  # bridge from before protocol 2: sends the finished state itself
                state["bridge_protocol"] = 1
            HUB.set_state(state, source=self.client_address[0])
            with HUB.cond:
                reply["program_id"] = HUB.program["id"]
            # The program id lets the bridge resend the program after a server restart.
            reply["commands"] = HUB.take_commands()
            self._json(200, reply)
        elif path == "/api/program":
            name, text = str(data.get("name", "")), str(data.get("text", ""))
            pid = HUB.set_program(name, text)
            log_bridge.info("program received: %s (%d lines, %.0f KB, id %s)", name or "(none)",
                            text.count("\n") + (1 if text and not text.endswith("\n") else 0), len(text) / 1024, pid)
            self._json(200, {"ok": True, "program_id": pid})
        else:
            self._json(404, {"error": "not found"})

    def _require_writer(self):
        """Check for anything that changes the machine or the Pi (E-stop, uploads, settings, updates)."""
        self.close_connection = True  # error replies may leave the request body unread
        # A custom header can't be sent by another website without CORS approval, so a
        # page elsewhere can't make the visitor's browser act on the machine.
        if self.headers.get("X-CNC-Control") != "1":
            log_http.warning("refused %s %s from %s: missing X-CNC-Control header", self.command, self.path,
                             self.client_address[0])
            self._json(403, {"ok": False, "message": "missing X-CNC-Control header"})
            return False
        return True

    # ---------- log: from the bridge, from browsers, for the Settings tab ----------

    def _bridge_log(self, entries):
        """Log lines the bridge collected in TNG (sent with its next update, so also those from
        while it couldn't reach the server)."""
        for e in entries[:200]:
            if not isinstance(e, dict):
                continue
            level = {"debug": logging.DEBUG, "warn": logging.WARNING, "error": logging.ERROR}.get(e.get("level"),
                                                                                                  logging.INFO)
            late = time.time() - _num(e.get("t"), time.time())
            log_bridge.log(level, "[TNG] %s%s", str(e.get("msg", ""))[:4000],
                           " (at %s)" % time.strftime("%H:%M:%S", time.localtime(e["t"])) if late > 3 else "")

    def _client_log(self):
        """Errors and events from a dashboard in a browser."""
        try:
            data = json.loads(self._read_body() or b"{}")
        except ValueError:
            self._json(400, {"ok": False})
            return
        ip = self.client_address[0]
        now = time.time()
        with CLIENT_LOG_LOCK:
            window_start, count = CLIENT_LOG_RATE.get(ip, (now, 0))
            if now - window_start > 60:
                window_start, count = now, 0
            entries = data.get("entries") if isinstance(data.get("entries"), list) else []
            allowed = max(0, CLIENT_LOG_LIMIT - count)
            CLIENT_LOG_RATE[ip] = (window_start, count + len(entries))
        who = "%s %s" % (ip, short_agent(self.headers.get("User-Agent")))
        for e in entries[:allowed]:
            if isinstance(e, dict):
                level = {"debug": logging.DEBUG, "warn": logging.WARNING,
                         "error": logging.ERROR}.get(e.get("level"), logging.INFO)
                late = now - _num(e.get("t"), now)  # sent later, e.g. after the connection came back
                log_client.log(level, "[%s] %s%s", who, str(e.get("msg", ""))[:4000],
                               " (page time %s)" % time.strftime("%H:%M:%S", time.localtime(e["t"])) if late > 5 else "")
        if len(entries) > allowed:
            log_client.warning("[%s] %d log lines dropped (more than %d per minute)", who,
                               len(entries) - allowed, CLIENT_LOG_LIMIT)
        if data.get("dropped"):
            log_client.warning("[%s] the page dropped %d log lines it could not send", who, data["dropped"])
        self._json(200, {"ok": True})

    def _logs_list(self):
        files = LOGS.files()
        self._json(200, {"ok": True, "dir": LOGS.dir, "files": files, "total": sum(f["size"] for f in files),
                         "max": LOGS.max_bytes, "keep_days": LOGS.keep_days, "debug": LOGS.debug_enabled()})

    def _logs_tail(self):
        """The end of the current log, optionally only warnings and errors."""
        try:
            lines = max(10, min(2000, int(self._query("lines") or 300)))
        except ValueError:
            lines = 300
        full = LOGS.path(LOG_FILE)
        if not full:
            self._send(200, "No log file (the server was started with --log-dir none).", "text/plain; charset=utf-8")
            return
        with open(full, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 2 * 2**20))  # the last 2 MB is plenty
            text = f.read().decode("utf-8", "replace").splitlines()
        if self._query("level") == "warn":
            text = [t for t in text if " WARNING " in t or " ERROR " in t or " CRITICAL " in t]
        self._send(200, "\n".join(text[-lines:]), "text/plain; charset=utf-8")

    def _logs_download(self):
        full = LOGS.path(self._query("name"))
        if not full:
            self._send(404, "Not found", "text/plain")
            return
        with open(full, "rb") as f:
            self._send(200, f.read(), "text/plain; charset=utf-8",
                       {"Content-Disposition": "attachment; filename*=UTF-8''%s" % quote(os.path.basename(full))})

    def _logs_level(self):
        try:
            debug = bool(json.loads(self._read_body() or b"{}").get("debug"))
        except ValueError:
            self._json(400, {"ok": False, "message": "invalid json"})
            return
        LOGS.set_debug(debug)
        try:
            save_settings({"log_debug": debug})
        except OSError as e:
            LOG.warning("could not save the log level: %s", e)
        LOG.info("detailed (debug) logging %s from %s", "on" if debug else "off", self.client_address[0])
        with HUB.cond:
            HUB.state_seq += 1  # tell the dashboards, so they send their debug lines too
            HUB.cond.notify_all()
        self._json(200, {"ok": True, "debug": debug})

    # ---------- read anything from TNG (through the bridge) ----------

    def _tng_read(self, fn_name, args_json):
        """GET /api/tng/call?f=param_get&args=["_hw_version"] - read-only planetcnc functions only."""
        if not (fn_name in TNG_READ_FUNCS or fn_name.startswith(TNG_READ_PREFIXES)):
            self._json(403, {"ok": False, "message": "only reading functions are allowed here"})
            return
        try:
            args = json.loads(args_json or "[]")
            if not isinstance(args, list):
                raise ValueError
        except ValueError:
            self._json(400, {"ok": False, "message": "args must be a JSON list"})
            return
        if not HUB.snapshot()[1]["bridge_online"]:
            self._json(409, {"ok": False, "message": "TNG bridge is offline"})
            return
        if (HUB.state.get("bridge_protocol") or 1) < 2:
            self._json(409, {"ok": False, "message": "the running bridge is too old - update it"})
            return
        result = HUB.wait_result(HUB.queue_command({"op": "call", "f": fn_name, "args": args}))
        self._json(200 if result["ok"] else 409, result)

    # ---------- E-stop: the one command the dashboard can give the machine ----------

    def _estop(self):
        """Switch TNG's E-stop on. The bridge only ever engages it; releasing happens at the machine."""
        who = "%s %s" % (self.client_address[0], short_agent(self.headers.get("User-Agent", "")))
        state = HUB.snapshot()[1]
        if not state["bridge_online"]:
            result = {"ok": False, "message": "TNG bridge is offline - the dashboard cannot reach the machine"}
        elif (state.get("bridge_protocol") or 1) < ESTOP_PROTOCOL:
            result = {"ok": False, "message": "the bridge running in TNG is too old for the E-stop - "
                                              "install the update, or restart TNG"}
        else:
            HUB.log("err", "E-STOP pressed on the dashboard (%s)" % who)
            result = HUB.wait_result(HUB.queue_command({"op": "estop"}, first=True))
        HUB.log("ok" if result["ok"] else "err",
                "E-stop: %s" % (result.get("message") or ("done" if result["ok"] else "failed")))
        self._json(200 if result["ok"] else 409, result)

    def _tng_open(self):
        """POST /api/tng/open {"path": "<inside the Files folder>"}: load that program in TNG.

        Loading only: the program is never started, and the bridge refuses while the machine runs.
        """
        try:
            rel = str(json.loads(self._read_body() or b"{}").get("path") or "")
        except (ValueError, AttributeError):
            self._json(400, {"ok": False, "message": "expected JSON with a path"})
            return
        full = self._files_path(rel) if rel else None
        if not full or not os.path.isfile(full):
            self._json(409, {"ok": False, "message": "file not found in the Files folder"})
            return
        result = self._open_in_tng(full)
        self._json(200 if result["ok"] else 409, result)

    def _tng_send(self):
        """POST /api/tng/send {"name": "plane.nc", "text": "<G-code>"}: load a program in TNG without
        saving it in the Files folder.

        The text goes to a working file in SENT_DIR (only the latest one is kept), which TNG opens.
        Loading only, as /api/tng/open.
        """
        try:
            data = json.loads(self._read_body() or b"{}")
            text = str(data.get("text") or "")
            name = os.path.basename(str(data.get("name") or "").replace("\\", "/")).strip()
        except (ValueError, AttributeError):
            self._json(400, {"ok": False, "message": "expected JSON with a name and a text"})
            return
        if not text.strip():
            self._json(400, {"ok": False, "message": "empty program"})
            return
        if len(text) > MAX_SEND_BYTES:
            self._json(413, {"ok": False, "message": "program larger than %d MB" % (MAX_SEND_BYTES // 2**20)})
            return
        name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name).lstrip(".") or "program.nc"
        if not name.lower().endswith(GCODE_EXTS):
            name += ".nc"
        state = HUB.snapshot()[1]
        if state.get("running"):
            # Never touch the file of a program that may be running
            self._json(409, {"ok": False, "message": "the machine is running - send it when it has stopped"})
            return
        full = os.path.join(SENT_DIR, name)
        try:
            os.makedirs(SENT_DIR, exist_ok=True)
            for old in os.listdir(SENT_DIR):      # keep only the program just sent
                if old != name:
                    try:
                        os.remove(os.path.join(SENT_DIR, old))
                    except OSError:
                        pass
            tmp = full + ".part"
            with open(tmp, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.replace(tmp, full)
        except OSError as e:
            self._json(500, {"ok": False, "message": "could not write the program: %s" % e})
            return
        result = self._open_in_tng(full)
        self._json(200 if result["ok"] else 409, result)

    def _open_in_tng(self, full):
        """Ask TNG to load `full` (a G-code file on this machine); the result for the page."""
        state = HUB.snapshot()[1]
        if not full.lower().endswith(GCODE_EXTS):
            result = {"ok": False, "message": "not a G-code file"}
        elif not state["bridge_online"]:
            result = {"ok": False, "message": "TNG bridge is offline"}
        elif (state.get("bridge_protocol") or 1) < OPEN_PROTOCOL:
            result = {"ok": False, "message": "the bridge running in TNG is too old to load programs - "
                                              "install the update, or restart TNG"}
        elif state.get("running"):
            result = {"ok": False, "message": "the machine is running - load it when it has stopped"}
        else:
            who = "%s %s" % (self.client_address[0], short_agent(self.headers.get("User-Agent", "")))
            result = HUB.wait_result(HUB.queue_command({"op": "open", "path": full}))
            HUB.log("info" if result["ok"] else "err", "Load in TNG: %s - %s (%s)" % (
                os.path.basename(full), result.get("message") or ("done" if result["ok"] else "failed"), who))
            if result["ok"]:
                result["loaded"] = self._wait_loaded(full)
                if not result["loaded"]:
                    result["message"] = "Asked TNG to open it, but TNG doesn't show it as loaded yet"
        return result

    @staticmethod
    def _wait_loaded(full, timeout=4.0):
        """True once TNG reports `full` as its loaded program (TNG may open it a moment later)."""
        end = time.time() + timeout
        while True:
            if norm_path(HUB.snapshot()[1].get("file")) == norm_path(full):
                return True
            if time.time() >= end:
                return False
            time.sleep(0.25)

    def _timelapse_download(self):
        path = TIMELAPSE.path(self._query("name")) if TIMELAPSE else None
        if not path:
            self._json(404, {"ok": False, "message": "no such timelapse"})
            return
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%s" % quote(os.path.basename(path)))
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 256 * 1024)

    # ---------- System window: OS packages, reboot / shut down ----------

    def _system_action(self, action):
        try:
            data = json.loads(self._read_body() or b"{}")
        except ValueError:
            data = {}
        if not OS_PACKAGES:
            self._json(409, {"ok": False, "message": "only available on a Linux computer with apt"})
            return
        if action == "check":
            self._json(200, dict(OS_PACKAGES.check(), ok=True))
            return
        if HUB.snapshot()[1].get("running"):
            self._json(409, {"ok": False, "message": "A program is running - do this afterwards"})
            return
        who = "%s %s" % (self.client_address[0], short_agent(self.headers.get("User-Agent", "")))
        if action == "upgrade":
            result = OS_PACKAGES.upgrade(who)
        else:
            result = power_action(str(data.get("action", "")), who)
        self._json(200 if result["ok"] else 409, result)

    # ---------- software update ----------

    def _update(self, action):
        if not self._require_writer():
            return
        if not UPDATER:
            self._json(409, {"ok": False, "message": UPDATES_OFF_REASON})
            return
        if action == "check":
            self._json(200, UPDATER.check())
            return
        if HUB.snapshot()[1].get("running"):
            self._json(409, {"ok": False, "message": "A program is running - update afterwards"})
            return
        HUB.log("cmd", "software %s" % action)
        result = UPDATER.apply(action)
        HUB.log("ok" if result["ok"] else "err", (result.get("output") or result.get("message", "")).strip()[-300:])
        self._json(200 if result["ok"] else 409, result)
        if result.get("restarting"):
            # systemd (Restart=always) starts the new version a few seconds after we exit.
            LOG.info("restarting to run the new version")
            threading.Timer(1.0, lambda: (logging.shutdown(), os._exit(0))).start()

    # ---------- settings ----------

    def _settings_view(self):
        return {"ok": True, "name": SETTINGS["name"],
                "camera": CAMERA.choice if CAMERA else "none", "camera_cmd": bool(CAMERA and CAMERA.command),
                "camera_view": bool(SETTINGS["camera_view"]),
                "camera_note": CONFIG.camera_note, "cameras": list_cameras() if CAMERA else [],
                "files_dir": CONFIG.files_dir, "files_dir_set": bool(SETTINGS["files_dir"]),
                "files_default": CONFIG.files_default,
                "tool_shape": bool(SETTINGS["tool_shape"]), "tool_cam": SETTINGS["tool_cam"],
                "tool_cams": [{"id": k, "label": v} for k, v in TOOL_CAMS.items()],
                "telegram": NOTIFY.view() if NOTIFY else None,
                "notify_progress": SETTINGS["notify_progress"], "notify_minutes": SETTINGS["notify_minutes"],
                "notify_photos": bool(SETTINGS["notify_photos"]),
                "notify_replace": bool(SETTINGS["notify_replace"]),
                "notify_events": [dict(zip(("kind", "label", "send", "silent"), (kind, label) + notify_rule(kind)))
                                  for kind, label, _ in NOTIFY_EVENTS],
                "timelapse": bool(SETTINGS["timelapse"]),
                "timelapse_interval": SETTINGS["timelapse_interval"],
                "timelapses": TIMELAPSE.list() if TIMELAPSE else [], "has_camera": bool(CAMERA),
                "mqtt": HA.view() if HA else None}

    def _settings_change(self):
        try:
            data = json.loads(self._read_body() or b"{}")
        except ValueError:
            self._json(400, {"ok": False, "message": "invalid json"})
            return
        changes = {}
        if "name" in data:
            name = " ".join(str(data["name"]).split())[:MAX_NAME_LENGTH]
            changes["name"] = name or DEFAULT_NAME
        if "camera" in data:
            choice = str(data["camera"])
            if not CAMERA or CAMERA.command:
                self._json(409, {"ok": False, "message": CONFIG.camera_note or "camera disabled"})
                return
            if choice not in ("auto", "none") and choice not in [c["path"] for c in list_cameras()]:
                self._json(400, {"ok": False, "message": "no camera %s" % choice})
                return
            changes["camera"] = choice
        if "files_dir" in data:
            folder = str(data["files_dir"] or "").strip()
            if folder:
                folder = os.path.realpath(os.path.expanduser(folder))
                if not os.path.isdir(folder):
                    self._json(400, {"ok": False, "message": "folder not found: %s" % folder})
                    return
            changes["files_dir"] = folder or None  # empty: back to --files-dir
        if "tool_shape" in data:
            changes["tool_shape"] = bool(data["tool_shape"])
        if "tool_cam" in data:
            if data["tool_cam"] not in TOOL_CAMS:
                self._json(400, {"ok": False, "message": "unknown CAM program %s" % data["tool_cam"]})
                return
            changes["tool_cam"] = data["tool_cam"]
        if "telegram_token" in data:
            token = str(data["telegram_token"] or "").strip()
            if token and not re.match(r"^\d+:[\w-]{20,}$", token):
                self._json(400, {"ok": False, "message": "that doesn't look like a bot token (123456:ABC-...)"})
                return
            changes["telegram_token"] = token
        if "telegram_chat" in data:
            chat = str(data["telegram_chat"] or "").strip()
            if chat and not re.match(r"^-?\d+$", chat):
                self._json(400, {"ok": False, "message": "a chat id is a number"})
                return
            changes["telegram_chat"] = chat
        for key, allowed in (("notify_progress", NOTIFY_PROGRESS_STEPS), ("notify_minutes", NOTIFY_MINUTES),
                             ("timelapse_interval", TIMELAPSE_INTERVALS)):
            if key in data:
                try:
                    value = int(data[key])
                except (TypeError, ValueError):
                    value = None
                if value not in allowed:
                    self._json(400, {"ok": False, "message": "%s must be one of %s" % (key, allowed)})
                    return
                changes[key] = value
        for key in ("camera_view", "notify_photos", "notify_replace", "timelapse"):
            if key in data:
                changes[key] = bool(data[key])
        if "mqtt_enabled" in data:
            changes["mqtt_enabled"] = bool(data["mqtt_enabled"])
        if "mqtt_host" in data:
            host = str(data["mqtt_host"] or "").strip()
            if host.startswith(("mqtt://", "tcp://")):
                host = host.split("://", 1)[1].rstrip("/")
            if len(host) > 253 or not re.match(r"^[\w.:\[\]-]*$", host):
                self._json(400, {"ok": False, "message": "broker: a host name or IP address, e.g. 192.168.1.10"})
                return
            changes["mqtt_host"] = host
        if "mqtt_port" in data:
            try:
                port = int(data["mqtt_port"])
            except (TypeError, ValueError):
                port = 0
            if not 1 <= port <= 65535:
                self._json(400, {"ok": False, "message": "port: a number from 1 to 65535 (usually 1883)"})
                return
            changes["mqtt_port"] = port
        if "mqtt_user" in data:
            changes["mqtt_user"] = str(data["mqtt_user"] or "").strip()[:200]
        if "mqtt_password" in data:
            changes["mqtt_password"] = str(data["mqtt_password"] or "")[:200]
        for key, what in (("mqtt_prefix", "discovery prefix"), ("mqtt_base", "base topic")):
            if key in data:
                topic = str(data[key] or "").strip().strip("/")
                if len(topic) > 120 or any(c in topic for c in "+#") or " " in topic:
                    self._json(400, {"ok": False, "message": "%s: a topic without spaces, + or #" % what})
                    return
                changes[key] = topic or ("homeassistant" if key == "mqtt_prefix" else "")
        for key in ("mqtt_machine_every", "mqtt_system_every"):
            if key in data:
                try:
                    value = int(data[key])
                except (TypeError, ValueError):
                    value = None
                if value not in MQTT_EVERY:
                    self._json(400, {"ok": False, "message": "%s must be one of %s" % (key, MQTT_EVERY)})
                    return
                changes[key] = value
        if "notify_events" in data:  # {kind: {"send": bool, "silent": bool}}, only the kinds that changed
            asked = data["notify_events"]
            kinds = {kind for kind, _, _ in NOTIFY_EVENTS}
            if not isinstance(asked, dict) or any(k not in kinds or not isinstance(v, dict) for k, v in asked.items()):
                self._json(400, {"ok": False, "message": "notify_events: unknown message kind"})
                return
            events = {k: dict(v) for k, v in (SETTINGS["notify_events"] or {}).items()}
            for kind, rule in asked.items():
                events.setdefault(kind, {}).update({f: bool(rule[f]) for f in ("send", "silent") if f in rule})
            changes["notify_events"] = events
        try:
            save_settings(changes)
        except OSError as e:
            self._json(500, {"ok": False, "message": "could not save settings: %s" % e})
            return
        LOG.info("settings changed from %s: %s", self.client_address[0],
                 {k: ("***" if k in ("telegram_token", "mqtt_password") and v else v) for k, v in changes.items()})
        if "telegram_token" in changes and NOTIFY:
            NOTIFY.connect()
            v = NOTIFY.view()
            HUB.log("info" if v["bot"] or not v["token_set"] else "warn", "Telegram: %s" % (
                "connected as @%s" % v["bot"] if v["bot"] else v["error"] or "off"))
        if HA and any(k in changes for k in ("mqtt_enabled", "mqtt_host", "mqtt_port", "mqtt_user", "mqtt_password",
                                              "mqtt_prefix", "mqtt_base")):
            HA.settings_changed()
            HUB.log("info", "Home Assistant (MQTT): %s" % ("connecting to %s" % SETTINGS["mqtt_host"] if HA.enabled()
                                                            else "off"))
        if "camera" in changes and changes["camera"] != CAMERA.choice:
            CAMERA.set_choice(changes["camera"])
            HUB.log("info", "Camera: %s" % changes["camera"])
        if "camera_view" in changes:
            HUB.log("info", "Camera on the dashboard: %s" % ("shown" if changes["camera_view"] else "hidden"))
        if "name" in changes:
            HUB.log("info", "Machine name: %s" % changes["name"])
        if "tool_shape" in changes or "tool_cam" in changes:
            HUB.log("info", "Tool in 3D view: %s" % (
                "from %s tool comments" % TOOL_CAMS[SETTINGS["tool_cam"]] if SETTINGS["tool_shape"] else "standard"))
        if "files_dir" in changes:
            apply_files_dir()
            HUB.log("info", "Files folder: %s" % (CONFIG.files_dir or "none"))
        with HUB.cond:
            HUB.state_seq += 1  # push the change to every open dashboard
            HUB.cond.notify_all()
        self._json(200, dict(self._settings_view(), message="Saved"))

    # ---------- file folder (--files-dir) ----------

    def _query(self, name):
        return parse_qs(urlparse(self.path).query).get(name, [""])[0]

    def _files_path(self, rel):
        """Absolute path for `rel` inside the files folder, or None if it would leave it."""
        if not CONFIG.files_dir:
            return None
        root = os.path.realpath(CONFIG.files_dir)
        full = os.path.realpath(os.path.join(root, rel.strip("/\\")))
        if full != root and not full.startswith(root + os.sep):
            return None  # "..", absolute paths or links pointing outside
        return full

    def _folders(self):
        """The folders (names only, never files) in a folder anywhere on the Pi: the folder
        picker of Settings > Files. Starts in the Files folder; shortcuts to home, USB drives
        and the root."""
        start = CONFIG.files_dir or os.path.expanduser("~")
        full = os.path.realpath(os.path.expanduser(self._query("path") or start))
        if not os.path.isdir(full):
            self._json(404, {"ok": False, "message": "folder not found: %s" % full})
            return
        try:
            with os.scandir(full) as it:
                dirs = sorted((e.name for e in it if not e.name.startswith(".") and e.is_dir()), key=str.lower)
        except OSError as e:
            self._json(403, {"ok": False, "path": full, "message": "cannot open %s: %s" % (full, e.strerror or e)})
            return
        parent = os.path.dirname(full)
        home = os.path.realpath(os.path.expanduser("~"))
        places = [{"name": "Home", "path": home}]
        for usb in ("/media/" + os.path.basename(home), "/media", "/mnt"):
            if os.path.isdir(usb):
                places.append({"name": "USB drives", "path": usb})
                break
        places.append({"name": "Whole disk", "path": os.path.abspath(os.sep)})
        self._json(200, {"ok": True, "path": full, "parent": parent if parent != full else None,
                         "dirs": dirs, "places": places})

    def _files_list(self):
        rel = self._query("path")
        full = self._files_path(rel)
        if not full or not os.path.isdir(full):
            self._json(404, {"ok": False, "message": "folder not found"})
            return
        entries = []
        with os.scandir(full) as it:
            for e in it:
                if e.name.startswith("."):
                    continue
                try:
                    st = e.stat()
                    entries.append({"name": e.name, "dir": e.is_dir(), "size": st.st_size, "mtime": st.st_mtime})
                except OSError:
                    pass
        entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
        root = os.path.realpath(CONFIG.files_dir)
        rel = "" if full == root else os.path.relpath(full, root).replace(os.sep, "/")
        self._json(200, {"ok": True, "root": os.path.basename(root) or root, "path": rel, "abs": full,
                         "entries": entries})

    def _files_download(self):
        full = self._files_path(self._query("path"))
        if not full or not os.path.isfile(full):
            self._send(404, "Not found", "text/plain")
            return
        name = os.path.basename(full)
        disposition = "inline" if self._query("inline") else "attachment"
        with open(full, "rb") as f:
            self._send(200, f.read(), "application/octet-stream",
                       {"Content-Disposition": "%s; filename*=UTF-8''%s" % (disposition, quote(name))})

    def _files_zip(self):
        """A folder of the files folder, with everything in it, as one zip (built in a temporary
        file and streamed, so a big folder doesn't have to fit in memory). Hidden files are left out."""
        full = self._files_path(self._query("path"))
        if not full or not os.path.isdir(full):
            self._send(404, "Not found", "text/plain")
            return
        name = (os.path.basename(full) or "files") + ".zip"
        count = 0
        with tempfile.TemporaryFile() as tmp:
            try:
                with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
                    for folder, dirs, files in os.walk(full):
                        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
                        rel_dir = os.path.relpath(folder, full)
                        if not files and not dirs and rel_dir != ".":
                            z.writestr(rel_dir.replace(os.sep, "/") + "/", "")   # keep empty folders
                        for f in sorted(files):
                            if f.startswith("."):
                                continue
                            try:
                                z.write(os.path.join(folder, f), os.path.normpath(os.path.join(rel_dir, f)))
                                count += 1
                            except OSError as e:
                                log_files.warning("zip of %s: skipped %s: %s", full, f, e)
            except OSError as e:
                log_files.error("zip of %s failed: %s", full, e)
                self._send(500, "could not make the zip: %s" % e, "text/plain")
                return
            size = tmp.tell()
            tmp.seek(0)
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%s" % quote(name))
            self.end_headers()
            if self.command != "HEAD":
                shutil.copyfileobj(tmp, self.wfile, 1 << 20)
        log_files.info("zip of %s: %d files, %d bytes (to %s)", full, count, size, self.client_address[0])

    def _files_upload(self):
        folder = self._files_path(self._query("path"))
        name = os.path.basename(self._query("name").replace("\\", "/")).strip()
        if not folder or not os.path.isdir(folder):
            self._json(404, {"ok": False, "message": "folder not found"})
            return
        if not name or name.startswith(".") or any(c in name for c in '<>:"|?*\0'):
            self._json(400, {"ok": False, "message": "invalid file name"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD_BYTES:
            self._json(413, {"ok": False, "message": "file larger than %d MB" % (MAX_UPLOAD_BYTES // 2**20)})
            return
        target = os.path.join(folder, name)
        if os.path.exists(target) and self._query("overwrite") != "1":
            self._json(409, {"ok": False, "exists": True, "message": "%s already exists" % name})
            return
        # Write to a temporary file first so a broken upload never leaves half a file behind.
        tmp = os.path.join(folder, ".upload-%d-%s" % (os.getpid(), name))
        try:
            with open(tmp, "wb") as f:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 1 << 20))
                    if not chunk:
                        raise OSError("upload interrupted")
                    f.write(chunk)
                    left -= len(chunk)
            os.replace(tmp, target)
        except OSError as e:
            try:
                os.remove(tmp)
            except OSError:
                pass
            log_files.error("upload of %s from %s failed: %s", target, self.client_address[0], e)
            self._json(500, {"ok": False, "message": "could not save: %s" % e})
            return
        log_files.info("uploaded %s (%d bytes, from %s)", target, length, self.client_address[0])
        self._json(200, {"ok": True, "message": "uploaded %s" % name})

    def _files_delete(self):
        try:
            rel = str(json.loads(self._read_body() or b"{}").get("path", ""))
        except ValueError:
            rel = ""
        full = self._files_path(rel)
        if not full or full == os.path.realpath(CONFIG.files_dir) or not os.path.isfile(full):
            self._json(404, {"ok": False, "message": "file not found (only files can be deleted)"})
            return
        try:
            os.remove(full)
        except OSError as e:
            log_files.error("deleting %s failed: %s", full, e)
            self._json(500, {"ok": False, "message": "could not delete: %s" % e})
            return
        log_files.info("deleted %s (from %s)", full, self.client_address[0])
        self._json(200, {"ok": True, "message": "deleted %s" % os.path.basename(full)})

    def _files_mkdir(self):
        """Make a new folder inside a folder of the files folder (New folder in the Files tab)."""
        try:
            data = json.loads(self._read_body() or b"{}")
            rel, name = str(data.get("path", "")), str(data.get("name", "")).strip()
        except (ValueError, AttributeError):
            self._json(400, {"ok": False, "message": "invalid json"})
            return
        parent = self._files_path(rel)
        if not parent or not os.path.isdir(parent):
            self._json(404, {"ok": False, "message": "folder not found"})
            return
        if (not name or name in (".", "..") or name.startswith(".") or len(name) > 100
                or any(c in name for c in '/\\<>:"|?*\0')):
            self._json(400, {"ok": False, "message": "invalid folder name"})
            return
        target = os.path.join(parent, name)
        if os.path.exists(target):
            self._json(409, {"ok": False, "message": "%s already exists" % name})
            return
        try:
            os.mkdir(target)
        except OSError as e:
            log_files.error("making folder %s failed: %s", target, e)
            self._json(500, {"ok": False, "message": "could not make the folder: %s" % e})
            return
        log_files.info("made folder %s (from %s)", target, self.client_address[0])
        self._json(200, {"ok": True, "message": "made folder %s" % name})

    def _files_rename(self):
        """Rename a folder of the files folder (the pencil in the Files tab). Not one holding the
        file loaded in TNG: TNG would lose it."""
        try:
            data = json.loads(self._read_body() or b"{}")
            rel, name = str(data.get("path", "")), str(data.get("name", "")).strip()
        except (ValueError, AttributeError):
            self._json(400, {"ok": False, "message": "invalid json"})
            return
        full = self._files_path(rel)
        if not full or full == os.path.realpath(CONFIG.files_dir) or not os.path.isdir(full):
            self._json(404, {"ok": False, "message": "folder not found"})
            return
        if (not name or name in (".", "..") or name.startswith(".") or len(name) > 100
                or any(c in name for c in '/\\<>:"|?*\0')):
            self._json(400, {"ok": False, "message": "invalid folder name"})
            return
        old = os.path.basename(full)
        if name == old:
            self._json(200, {"ok": True, "message": "%s keeps its name" % old})
            return
        loaded = HUB.snapshot()[1].get("file")
        if loaded and norm_path(loaded).startswith(norm_path(full) + os.sep):
            self._json(409, {"ok": False, "message": "%s holds the file loaded in TNG: it cannot be renamed" % old})
            return
        target = os.path.join(os.path.dirname(full), name)
        # A case-only change on Windows is the same folder: allowed
        if os.path.exists(target) and os.path.normcase(target) != os.path.normcase(full):
            self._json(409, {"ok": False, "message": "%s already exists" % name})
            return
        try:
            os.rename(full, target)
        except OSError as e:
            log_files.error("renaming %s to %s failed: %s", full, name, e)
            self._json(500, {"ok": False, "message": "could not rename: %s" % (e.strerror or e)})
            return
        log_files.info("renamed folder %s to %s (from %s)", full, name, self.client_address[0])
        self._json(200, {"ok": True, "message": "renamed %s to %s" % (old, name)})

    def _files_move(self):
        """Move a file into another folder of the files folder (drag and drop in the Files tab).
        Never the file loaded in TNG: TNG would lose it."""
        try:
            data = json.loads(self._read_body() or b"{}")
            rel, to = str(data.get("path", "")), str(data.get("to", ""))
            overwrite = bool(data.get("overwrite"))
        except (ValueError, AttributeError):
            self._json(400, {"ok": False, "message": "invalid json"})
            return
        full = self._files_path(rel)
        folder = self._files_path(to)
        if not full or full == os.path.realpath(CONFIG.files_dir) or not os.path.isfile(full):
            self._json(404, {"ok": False, "message": "file not found (only files can be moved)"})
            return
        if not folder or not os.path.isdir(folder):
            self._json(404, {"ok": False, "message": "folder not found"})
            return
        name = os.path.basename(full)
        if os.path.dirname(full) == folder:
            self._json(200, {"ok": True, "message": "%s is already there" % name})
            return
        loaded = HUB.snapshot()[1].get("file")
        if loaded and norm_path(loaded) == norm_path(full):
            self._json(409, {"ok": False, "message": "%s is loaded in TNG: it cannot be moved" % name})
            return
        target = os.path.join(folder, name)
        if os.path.exists(target) and not overwrite:
            self._json(409, {"ok": False, "exists": True, "message": "%s already exists there" % name})
            return
        try:
            os.replace(full, target)
        except OSError as e:
            log_files.error("moving %s to %s failed: %s", full, folder, e)
            self._json(500, {"ok": False, "message": "could not move: %s" % e})
            return
        log_files.info("moved %s to %s (from %s)", full, folder, self.client_address[0])
        root = os.path.realpath(CONFIG.files_dir)
        where = os.path.basename(root) if folder == root else os.path.relpath(folder, root).replace(os.sep, "/")
        self._json(200, {"ok": True, "message": "moved %s to %s" % (name, where)})

    # ---------- feeds log (Feeds & steps window, Feeds tab) ----------

    def _tuning_change(self):
        try:
            data = json.loads(self._read_body() or b"{}")
            action = data.get("action")
        except (ValueError, AttributeError):
            self._json(400, {"ok": False, "message": "invalid json"})
            return
        try:
            if action == "add":
                rel = str(data.get("path", ""))
                full = self._files_path(rel)
                if not full or not os.path.isfile(full):
                    self._json(404, {"ok": False, "message": "file not found"})
                    return
                ops = data.get("ops")
                if not isinstance(ops, list) or len(json.dumps(ops)) > 200000:
                    self._json(400, {"ok": False, "message": "invalid operations"})
                    return
                entry = TUNING.add({"time": time.time(), "name": os.path.basename(full), "path": rel, "abs": full,
                                    "source": str(data.get("source", ""))[:300], "base": str(data.get("base", ""))[:300],
                                    "units": "in" if data.get("units") == "in" else "mm", "ops": ops,
                                    "status": "", "note": str(data.get("note", ""))[:1000], "runs": []})
                log_files.info("feeds log: %s adjusted from %s (from %s)", rel, entry["source"], self.client_address[0])
                result = (200, {"ok": True, "entry": entry})
            elif action == "update":
                changes = {}
                if "status" in data:
                    if data["status"] not in TuningLog.STATUSES:
                        self._json(400, {"ok": False, "message": "invalid status"})
                        return
                    changes["status"] = data["status"]
                if "note" in data:
                    changes["note"] = str(data["note"])[:1000]
                e = TUNING.update(str(data.get("id", "")), changes)
                result = (200 if e else 404, {"ok": bool(e), "entry": e, "message": "" if e else "entry not found"})
            elif action == "delete":
                ok = TUNING.delete(str(data.get("id", "")))
                result = (200 if ok else 404, {"ok": ok, "message": "deleted" if ok else "entry not found"})
            else:
                self._json(400, {"ok": False, "message": "unknown action"})
                return
        except OSError as e:
            log_files.error("cannot save the feeds log: %s", e)
            self._json(500, {"ok": False, "message": "could not save: %s" % e})
            return
        with HUB.cond:
            HUB.state_seq += 1  # every open dashboard reloads the log
            HUB.cond.notify_all()
        self._json(*result)

    # ---------- material presets of the /planing page ----------

    def _presets_change(self, store):
        """Save or delete a material or a bit (store: PRESETS or BITS)."""
        try:
            data = json.loads(self._read_body() or b"{}")
            action = data.get("action")
        except (ValueError, AttributeError):
            self._json(400, {"ok": False, "message": "invalid json"})
            return
        try:
            if action == "save":
                name, values = store.clean(data.get("name"), data.get("values"))
                store.save(name, values)
                log_files.info("planing %s %s saved: %s (from %s)", store.what, name, values, self.client_address[0])
                result = {"ok": True, "name": name, "message": "Saved %s" % name}
            elif action == "delete":
                name = str(data.get("name", ""))
                if not store.delete(name):
                    self._json(404, {"ok": False, "message": "no %s called %s" % (store.what, name)})
                    return
                log_files.info("planing %s %s deleted (from %s)", store.what, name, self.client_address[0])
                result = {"ok": True, "message": "Deleted %s" % name}
            else:
                self._json(400, {"ok": False, "message": "unknown action"})
                return
        except ValueError as e:
            self._json(400, {"ok": False, "message": str(e)})
            return
        except OSError as e:
            log_files.error("cannot save the planing %s: %s", store.what_plural, e)
            self._json(500, {"ok": False, "message": "could not save: %s" % e})
            return
        self._json(200, dict(result, presets=store.list()))

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        elif path == "/camera":
            path = "/camera.html"  # the camera on its own, without the dashboard
        elif path == "/planing":
            path = "/planing.html"  # program for planing rough stock
        elif path == "/materials":
            path = "/materials.html"  # the planing page's materials: see, change, add, import, export
        elif path == "/system":
            path = "/system.html"  # versions, updates, reboot / shut down
        elif path == "/settings":
            path = "/settings.html"  # name, camera, Files folder, Telegram, timelapse, logs
        full = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            self._send(404, "Not found", "text/plain")
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript"
        cache = None
        if full.endswith(".glb"):
            # The machine model is big and rarely changes: browsers keep it, but ask each time
            # whether it changed (after an update it may have), and get "304 Not Modified" if not
            ctype = "model/gltf-binary"
            st = os.stat(full)
            etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
            if self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                return
            cache = {"Cache-Control": "no-cache", "ETag": etag}
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype, cache)

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        # Without a timeout, a browser that vanished without closing the connection (Wi-Fi dropped,
        # laptop asleep) would keep this thread blocked forever.
        self.connection.settimeout(STREAM_WRITE_TIMEOUT)
        who = "%s %s" % (self.client_address[0], short_agent(self.headers.get("User-Agent")))
        log_http.info("dashboard connected: %s (%d open)", who, STREAMS.change("dashboard", 1))
        started, sent, reason = time.time(), 0, "?"
        last_seq = -1
        try:
            while True:
                with HUB.cond:
                    # Wake on change, or every second so 'bridge offline' gets noticed.
                    HUB.cond.wait_for(lambda: HUB.state_seq != last_seq, timeout=1.0)
                seq, snap = HUB.snapshot()
                last_seq = seq
                self.wfile.write(("data: " + json.dumps(snap) + "\n\n").encode("utf-8"))
                self.wfile.flush()
                sent += 1
        except socket.timeout:
            reason = "browser stopped reading for %.0f s" % STREAM_WRITE_TIMEOUT
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError) as e:
            reason = "closed by the browser" if isinstance(e, (BrokenPipeError, ConnectionResetError,
                                                               ConnectionAbortedError)) else str(e)
        finally:
            log_http.info("dashboard disconnected: %s after %s, %d updates sent (%s; %d still open)", who,
                          fmt_duration(time.time() - started), sent, reason, STREAMS.change("dashboard", -1))

    def _camera_stream(self):
        if CAMERA is None:
            self._send(404, "Camera disabled", "text/plain")
            return
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        if self.command == "HEAD":
            return
        self.connection.settimeout(STREAM_WRITE_TIMEOUT)
        who = "%s %s" % (self.client_address[0], short_agent(self.headers.get("User-Agent")))
        log_camera.info("viewer connected: %s (%d open)", who, STREAMS.change("camera", 1))
        started, sent, reason = time.time(), 0, "?"
        CAMERA.add_client()
        try:
            seq = -1
            while True:
                jpeg, seq = CAMERA.wait_frame(seq, CAMERA_KEEPALIVE)
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n"
                                 % len(jpeg) + jpeg + b"\r\n")
                sent += 1
        except socket.timeout:
            reason = "browser stopped reading for %.0f s" % STREAM_WRITE_TIMEOUT
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError) as e:
            reason = "closed by the browser" if isinstance(e, (BrokenPipeError, ConnectionResetError,
                                                               ConnectionAbortedError)) else str(e)
        finally:
            CAMERA.remove_client()
            log_camera.info("viewer disconnected: %s after %s, %d frames sent (%s; %d still open)", who,
                            fmt_duration(time.time() - started), sent, reason, STREAMS.change("camera", -1))

    def _camera_still(self):
        """One JPEG from the camera, for bookmarks, other programs (home automation,
        OBS) and anything that can't show an MJPEG stream."""
        if CAMERA is None or not CAMERA.enabled():
            self._send(404, "No camera", "text/plain")
            return
        if self.command == "HEAD":
            self._send(200, b"", "image/jpeg")
            return
        SNAPSHOT_HOLD_STATE.touch()  # the camera stays on a while, for the next request
        jpeg = camera_snapshot()     # starts the camera when nobody is watching
        if jpeg is None:
            self._send(503, "No camera signal", "text/plain", {"Retry-After": "5"})
            return
        self._send(200, jpeg, "image/jpeg")


# ---------------------------------------------------------------------------
# Demo mode: a simulated machine running a generated program
# ---------------------------------------------------------------------------

def demo_program():
    lines = ["(PlanetCNC Observatory - demo program)", "G21 G90 G17", "G54", "T1 M6", "S12000 M3",
             "G0 Z5", "G0 X0 Y0"]
    # Facing / pocket raster in two depth passes
    for depth in (-1.0, -2.0):
        lines.append("G0 X10 Y10")
        lines.append("G1 Z%.3f F300" % depth)
        y = 10.0
        forward = True
        while y <= 60.0:
            lines.append("G1 X%.3f Y%.3f F1500" % (90.0 if forward else 10.0, y))
            y += 4.0
            if y <= 60.0:
                lines.append("G1 Y%.3f" % y)
            forward = not forward
        lines.append("G0 Z5")
    # Circular boss contour with arcs
    lines += ["G0 X70 Y80", "G1 Z-3 F300", "G2 X70 Y80 I-20 J0 F1200", "G0 Z5"]
    # Spiral of small holes
    for i in range(12):
        a = i * math.pi / 6
        x, y = 50 + 25 * math.cos(a), 80 + 25 * math.sin(a) * 0.4
        lines += ["G0 X%.3f Y%.3f" % (x, y), "G1 Z-4 F200", "G0 Z5"]
    # Rounded rectangle outline (G3 corners)
    lines += ["G0 X5 Y0", "G1 Z-2 F300", "G1 X95 F1500", "G3 X100 Y5 I0 J5", "G1 Y105",
              "G3 X95 Y110 I-5 J0", "G1 X5", "G3 X0 Y105 I0 J-5", "G1 Y5", "G3 X5 Y0 I5 J0",
              "G0 Z25", "M5", "G0 X0 Y0", "M30"]
    return "\n".join(lines) + "\n"


def demo_moves(text):
    """Very small interpreter for the demo program -> list of (line_no, x, y, z, rapid)."""
    pos = [0.0, 0.0, 25.0]
    pts = []
    motion = 0
    for n, raw in enumerate(text.splitlines(), start=1):
        code = raw.split("(")[0].upper()
        words = {}
        tok = ""
        for ch in code + " ":
            if ch.isalpha():
                if tok:
                    words.setdefault(tok[0], []).append(float(tok[1:]))
                tok = ch
            elif ch in "0123456789.-+" and tok:
                tok += ch
        if tok and len(tok) > 1:
            words.setdefault(tok[0], []).append(float(tok[1:]))
        for g in words.get("G", []):
            if g in (0, 1, 2, 3):
                motion = int(g)
        if not any(k in words for k in "XYZ"):
            continue
        tgt = [words.get(a, [p])[0] for a, p in zip("XYZ", pos)]
        if motion in (2, 3):
            cx, cy = pos[0] + words.get("I", [0])[0], pos[1] + words.get("J", [0])[0]
            a0 = math.atan2(pos[1] - cy, pos[0] - cx)
            a1 = math.atan2(tgt[1] - cy, tgt[0] - cx)
            r = math.hypot(pos[0] - cx, pos[1] - cy)
            sweep = a1 - a0
            if motion == 2:
                sweep = sweep if sweep < 0 else sweep - 2 * math.pi
            else:
                sweep = sweep if sweep > 0 else sweep + 2 * math.pi
            steps = max(8, int(abs(sweep) * r / 1.0))
            for i in range(1, steps + 1):
                a = a0 + sweep * i / steps
                pts.append((n, cx + r * math.cos(a), cy + r * math.sin(a),
                            pos[2] + (tgt[2] - pos[2]) * i / steps, False))
        else:
            pts.append((n, tgt[0], tgt[1], tgt[2], motion == 0))
        pos = tgt
    return pts




DEMO_ESTOP = threading.Event()   # the dashboard's E-stop in demo mode
DEMO_ESTOP_HOLD = 8.0            # seconds before the simulated operator releases it "at the machine"


def demo_commands():
    """Answer the server's requests (reads, E-stop) in demo mode."""
    while True:
        time.sleep(0.2)
        results = []
        for c in HUB.take_commands():
            if c.get("op") == "estop":
                DEMO_ESTOP.set()
                results.append({"id": c["id"], "ok": True, "message": "E-stop engaged (demo)"})
            else:
                results.append({"id": c["id"], "ok": True, "message": "demo: %s accepted" % c.get("op")})
        HUB.add_results(results)


def demo_estop(pos, line_no, line_count):
    """Hold the demo machine in E-stop for a while, as if someone then released it at the machine."""
    end = time.time() + DEMO_ESTOP_HOLD
    while time.time() < end:
        HUB.set_state({"work": pos + [0.0] * 6, "machine": [pos[0] + 120.0, pos[1] + 80.0, pos[2] - 40.0] + [0.0] * 6,
                       "line": line_no, "line_count": line_count, "feed": 0.0, "spindle": 0.0, "tool": 1,
                       "units": "mm", "coordsys": "G54", "running": False, "paused": False, "estop": True,
                       "idle": False, "limits": DEMO_LIMITS, "file": "C:/CNC/demo_part.nc", "bridge_protocol": ESTOP_PROTOCOL})
        time.sleep(0.1)
    DEMO_ESTOP.clear()


# The demo machine's travel, in machine coordinates (work = machine - (120, 80, -40) in the demo)
DEMO_LIMITS = {"min": [0.0, 0.0, -110.0], "max": [800.0, 600.0, 0.0]}


def run_demo():
    text = demo_program()
    HUB.set_program("C:/CNC/demo_part.nc", text)
    moves = demo_moves(text)
    line_count = len(text.splitlines())
    while True:
        pos = [0.0, 0.0, 25.0]
        start = time.time()
        for line_no, x, y, z, rapid in moves:
            if DEMO_ESTOP.is_set():
                demo_estop(pos, line_no, line_count)
                break
            feed = 5000.0 if rapid else 1500.0
            dist = math.dist(pos, (x, y, z))
            steps = max(1, int(dist / (feed / 60.0) / 0.1))
            p, target = pos, [x, y, z]
            for i in range(1, steps + 1):
                if DEMO_ESTOP.is_set():
                    target = p  # stopped mid-move: the next round sees the E-stop
                    break
                p = [pos[k] + ((x, y, z)[k] - pos[k]) * i / steps for k in range(3)]
                HUB.set_state({
                    "work": p + [0.0] * 6,
                    "machine": [p[0] + 120.0, p[1] + 80.0, p[2] - 40.0] + [0.0] * 6,
                    "line": line_no, "line_count": line_count,
                    "feed": feed, "spindle": 12000.0, "tool": 1, "units": "mm",
                    "coordsys": "G54", "running": True, "paused": False, "limits": DEMO_LIMITS,
                    "estop": False, "idle": False, "file": "C:/CNC/demo_part.nc",
                    "elapsed": time.time() - start, "time_to_end": None, "bridge_protocol": ESTOP_PROTOCOL,
                })
                time.sleep(0.1)
            pos = target
        else:
            if DEMO_ESTOP.is_set():  # pressed during the last move
                demo_estop(pos, line_count, line_count)
        for _ in range(30):  # idle a few seconds between runs
            if DEMO_ESTOP.is_set():
                demo_estop(pos, line_count, line_count)
                break
            HUB.set_state({"work": pos + [0.0] * 6,
                           "machine": [pos[0] + 120.0, pos[1] + 80.0, pos[2] - 40.0] + [0.0] * 6,
                           "line": line_count, "line_count": line_count, "feed": 0.0,
                           "spindle": 0.0, "tool": 1, "units": "mm", "coordsys": "G54",
                           "running": False, "paused": False, "estop": False, "idle": True,
                           "limits": DEMO_LIMITS,
                           "file": "C:/CNC/demo_part.nc", "bridge_protocol": ESTOP_PROTOCOL})
            time.sleep(0.1)


def watch_bridge():
    """Note in the console when the bridge stops sending (connecting is logged in set_state)."""
    online = False
    while True:
        time.sleep(1.0)
        with HUB.cond:
            now_online = HUB.last_state_time > 0 and time.time() - HUB.last_state_time < BRIDGE_TIMEOUT
        if online and not now_online:
            with HUB.cond:
                HUB.offline_since = HUB.last_state_time
            HUB.log("warn", "TNG bridge lost - no updates for %d s" % BRIDGE_TIMEOUT)
            if NOTIFY and HUB.state.get("job"):
                NOTIFY.event("bridge_lost")
        online = now_online


def fmt_duration(sec):
    sec = int(sec)
    return "%d:%02d:%02d" % (sec // 3600, sec // 60 % 60, sec % 60) if sec >= 3600 else "%d:%02d" % (sec // 60, sec % 60)


def heartbeat():
    """A status line every few minutes: where the job stood and how the server was doing,
    for reconstructing what happened before a problem."""
    last = (time.time(), HUB.bridge_updates)
    while True:
        time.sleep(HEARTBEAT_EVERY)
        now, updates = time.time(), HUB.bridge_updates
        rate = (updates - last[1]) / (now - last[0])
        last = (now, updates)
        seq, s = HUB.snapshot()
        parts = ["bridge %s (%.1f updates/s)" % ("online" if s["bridge_online"] else "OFFLINE", rate)]
        if s.get("job"):
            total = s.get("line_count") or 0
            parts.append("job line %s/%s (%.0f %%)%s" % (
                s.get("line"), total or "?", 100.0 * s.get("line", 0) / total if total else 0,
                ", %s left" % fmt_duration(s["time_to_end"]) if (s.get("time_to_end") or -1) >= 0 else ""))
        else:
            parts.append("no job running")
        parts.append("%d dashboard(s), %d camera viewer(s)" % (STREAMS.open["dashboard"], STREAMS.open["camera"]))
        parts.append("%d threads" % threading.active_count())
        rss = _read_text("/proc/self/statm").split()
        if len(rss) > 1:
            parts.append("server memory %.0f MB" % (int(rss[1]) * os.sysconf("SC_PAGE_SIZE") / 2**20))
        sysinfo = s.get("system") or {}
        if sysinfo.get("cpu") is not None:
            parts.append("CPU %.0f %%" % sysinfo["cpu"])
        if sysinfo.get("temp") is not None:
            parts.append("%.0f \u00b0C" % sysinfo["temp"])
        log_system.info("status: " + ", ".join(parts))


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        """An exception in a request handler: log it with its traceback (default: stderr only)."""
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout)):
            log_http.debug("connection from %s ended: %s", client_address[0], exc)
        else:
            log_http.error("error while answering %s", client_address[0], exc_info=True)


def lan_address():
    """This machine's address on the local network, i.e. what other computers should open."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # UDP connect sends nothing; it just picks the outgoing interface
            return s.getsockname()[0]
    except OSError:
        return "localhost"


def main():
    ap = argparse.ArgumentParser(description="PlanetCNC Observatory server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--token", default=os.environ.get("PCNC_TOKEN", ""),
                    help="shared secret the bridge must send (X-Bridge-Token)")
    ap.add_argument("--viewer-password", help=argparse.SUPPRESS)  # no longer used; old service files still start
    ap.add_argument("--demo", action="store_true", help="simulate a running machine")
    ap.add_argument("--camera", default=os.environ.get("PCNC_CAMERA", "auto"),
                    help="V4L2 camera device, 'auto' (first camera found) or 'none'; "
                         "a camera chosen in the dashboard's settings takes precedence")
    ap.add_argument("--camera-size", default="1280x720", help="requested resolution, e.g. 640x480")
    ap.add_argument("--camera-fps", type=int, default=15, help="requested frame rate")
    ap.add_argument("--camera-cmd", default=os.environ.get("PCNC_CAMERA_CMD", ""),
                    help="custom command that writes MJPEG to stdout (overrides --camera)")
    ap.add_argument("--line-offset", type=int, default=0,
                    help="add to TNG's line number if the highlighted G-code line is off by one")
    ap.add_argument("--files-dir", default=os.environ.get("PCNC_FILES_DIR", "auto"),
                    help="folder shown in the Files tab ('auto' = ~/Desktop, else home; 'none' to disable); "
                         "a folder chosen in the dashboard's settings takes precedence")
    ap.add_argument("--log-dir", default=os.environ.get("PCNC_LOG_DIR", os.path.join(APP_DIR, "logs")),
                    help="folder for the log files (default: logs/ next to server.py; 'none' = console only)")
    ap.add_argument("--log-max-mb", type=int, default=50, help="most disk space the log files may use (MB)")
    ap.add_argument("--log-keep-days", type=int, default=30, help="delete log files older than this")
    ap.add_argument("--debug", action="store_true", help="detailed logging (also switchable in Settings)")
    args = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)  # show messages in journalctl right away, not when a buffer fills
    CONFIG.token = args.token
    load_settings()
    LOGS.setup(args.log_dir, args.log_max_mb, args.log_keep_days, args.debug or SETTINGS["log_debug"])
    try:
        version = subprocess.run(["git", "log", "-1", "--format=%h %s"], cwd=APP_DIR, capture_output=True,
                                 text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        version = ""
    CONFIG.version = version.split(" ", 1)[0]
    LOG.info("starting: version %s, Python %s, pid %d%s", version or "unknown", sys.version.split()[0], os.getpid(),
             ", under systemd" if os.environ.get("INVOCATION_ID") else "")
    LOG.info("logs: %s (at most %d MB, kept %d days%s)", LOGS.dir or "console only", args.log_max_mb,
             args.log_keep_days, ", detailed" if LOGS.debug_enabled() else "")
    LOG.debug("options: %s", {k: ("***" if k == "token" and v else v) for k, v in vars(args).items()})
    CONFIG.line_offset = args.line_offset
    files_dir = args.files_dir
    if files_dir == "auto":
        desktop = os.path.expanduser("~/Desktop")
        files_dir = desktop if os.path.isdir(desktop) else os.path.expanduser("~")
    if files_dir != "none":
        if os.path.isdir(files_dir):
            CONFIG.files_default = os.path.realpath(files_dir)
        else:
            log_files.warning("folder %s not found, file view disabled", files_dir)
    apply_files_dir()

    global CAMERA, SYSTEM, UPDATER, UPDATES_OFF_REASON, TUNING, PRESETS, BITS, OS_PACKAGES, NOTIFY, TIMELAPSE, HA
    TUNING = TuningLog(TUNING_FILE)
    PRESETS = PlaningPresets(PRESETS_FILE)
    BITS = PlaningPresets(BITS_FILE, keys=("d",), what="bit", what_plural="bits")
    threading.Thread(target=watch_bridge, name="watch-bridge", daemon=True).start()
    threading.Thread(target=heartbeat, name="heartbeat", daemon=True).start()
    if SystemStats.available():
        SYSTEM = SystemStats()
    if Updater.available():
        UPDATER = Updater()
        UPDATER.refresh(fetch=False)
    else:
        UPDATES_OFF_REASON = ("git is not installed (sudo apt install git)" if not shutil.which("git") else
                              "%s is not a git clone - see README" % APP_DIR)
        log_update.warning(UPDATES_OFF_REASON)
    if OsPackages.available() and not args.demo:
        OS_PACKAGES = OsPackages()
    if args.camera_cmd:
        CAMERA = Camera(command=args.camera_cmd)
        CONFIG.camera_note = "set by --camera-cmd on the server"
        log_camera.info("custom command: %s", args.camera_cmd)
    elif shutil.which("ffmpeg"):
        choice = SETTINGS["camera"] or args.camera
        CAMERA = Camera(choice, args.camera_size, args.camera_fps)
        log_camera.info("%s (%s @ %d fps); found: %s", choice, args.camera_size, args.camera_fps,
                        ", ".join(c["label"] for c in list_cameras()) or "no camera")
    else:
        CONFIG.camera_note = "ffmpeg is not installed (sudo apt install ffmpeg)"
        log_camera.warning("ffmpeg not found, camera disabled (sudo apt install ffmpeg)")

    TIMELAPSE = Timelapse()
    NOTIFY = Notifier()
    startup_notices()
    HA = HomeAssistant(args.port)

    if args.demo:
        if not SYSTEM:
            SYSTEM = DemoStats()
        threading.Thread(target=run_demo, daemon=True).start()
        threading.Thread(target=demo_commands, daemon=True).start()

    try:
        httpd = Server((args.host, args.port), Handler)
    except OSError as e:
        LOG.critical("cannot listen on %s:%d: %s (is another copy already running?)", args.host, args.port, e)
        sys.exit(1)
    address = lan_address() if args.host == "0.0.0.0" else args.host
    LOG.info("Observatory on http://%s:%d%s", address, args.port, "  (demo mode)" if args.demo else "")
    if sys.stdout.isatty():  # started by hand: say plainly which address to open
        print("\n  Open the dashboard%s:\n"
              "    from another device on your network:  http://%s:%d\n"
              "    on this computer:                     http://localhost:%d\n"
              "  Press Ctrl+C to stop.\n" % (" (demo)" if args.demo else "", address, args.port, args.port))
    # systemd stops the service with SIGTERM (the Pi shutting down or rebooting, or the service
    # being stopped): tell Telegram, unless the System page already did, and exit normally so it
    # gets logged. An update's restart doesn't come this way.
    def on_term(*_):
        if NOTIFY and not STOP_ANNOUNCED:
            NOTIFY.system("\U0001f534 <b>Observatory is stopping</b>: the Raspberry Pi is shutting down or "
                          "rebooting, or the service was stopped.", now=True)
        sys.exit(0)
    signal.signal(signal.SIGTERM, on_term)
    try:
        httpd.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        LOG.info("stopping")
    except Exception:
        LOG.critical("server stopped by an error", exc_info=True)
        raise


if __name__ == "__main__":
    main()
