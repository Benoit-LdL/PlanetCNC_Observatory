"""Retake the README screenshots (media/screenshots/) from the demo.

Not needed on the Pi. On a PC with Google Chrome (or Edge: --browser msedge):

    pip install playwright
    python server.py --demo --port 8097 --log-dir none     # in one terminal
    python tools/screenshots.py                             # in another

Takes a phone (iPhone 14 size) and a desktop (1920x1080) set in night mode: the dashboard, the 3D
view on the phone, the Console and Settings tabs, the Surfacing and System pages; and the desktop
dashboard in day mode.
"""
import argparse
import os

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
PI_FOLDER = "/home/mekanika/Desktop"  # typed into Settings > Files instead of this PC's folder (not saved)
PI_TOPIC = "planetcnc_observatory/raspberrypi"   # MQTT base topic shown instead of this PC's name
PI_HOST = {"hostname": "raspberrypi", "address": "192.168.1.20"}   # System page: not this PC's name and address

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://localhost:8097")
ap.add_argument("--out", default=os.path.join(HERE, "..", "media", "screenshots"))
ap.add_argument("--browser", default="chrome", help="chrome or msedge")
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)


def shot(page, name, last=True):
    """Save the page as `name`.png; then close it unless more shots of it follow (`last=False`): pages left
    open keep polling the demo server, which slows the next ones down."""
    page.screenshot(path=os.path.join(args.out, name + ".png"))
    if last:
        page.context.close()


with sync_playwright() as p:
    browser = p.chromium.launch(channel=args.browser)

    def pi_host(route):
        """/api/system with a Pi's name and address instead of this PC's (the screenshots are public)."""
        r = route.fetch()
        d = r.json()
        if isinstance(d.get("host"), dict):
            d["host"].update(PI_HOST)
        route.fulfill(response=r, json=d)

    def open_page(path="/", theme="dark", **context):
        ctx = browser.new_context(**context)
        ctx.route("**/api/system*", pi_host)
        ctx.add_init_script(f"try {{ localStorage.setItem('theme', '{theme}') }} catch (e) {{}}")
        page = ctx.new_page()
        page.goto(args.url + path, wait_until="domcontentloaded")
        page.wait_for_timeout(7000)  # demo job running, 3D view drawn
        return page

    def open_tab(page, name, scroll=False):
        page.click(f'.ptab[data-ptab="{name}"]')
        page.wait_for_timeout(1500)
        if scroll:  # phone: bring the tab panel into view
            page.evaluate("document.getElementById('sidePanel').scrollIntoView({block: 'start'})")
            page.wait_for_timeout(500)

    phone = dict(p.devices["iPhone 14"], device_scale_factor=2)
    page = open_page(**phone)
    shot(page, "mobile", last=False)
    page.evaluate("document.querySelector('.view-panel').scrollIntoView({block: 'start'})")
    page.wait_for_timeout(800)
    shot(page, "mobile-3d", last=False)
    open_tab(page, "console", scroll=True)
    shot(page, "mobile-console")

    def settings_page(**context):
        page = open_page("/settings", **context)
        page.fill("#filesDirInput", PI_FOLDER)
        page.evaluate("t => { document.getElementById('mqttBase').placeholder = t; }", PI_TOPIC)
        return page
    shot(settings_page(**phone), "mobile-settings")

    desk = {"viewport": {"width": 1920, "height": 1080}}
    page = open_page(**desk)
    shot(page, "desktop", last=False)
    open_tab(page, "console")
    shot(page, "desktop-console")
    shot(settings_page(**desk), "desktop-settings")
    page = open_page("/surfacing", **desk)
    page.evaluate("f => { document.getElementById('folderHint').textContent = `Saved in ${f}.`; }", PI_FOLDER)
    shot(page, "desktop-surfacing")
    page = open_page("/system", **desk)
    page.wait_for_selector("#hostRows .kv", timeout=30000)   # slow on a PC: system info takes a few seconds
    page.wait_for_timeout(1000)
    shot(page, "desktop-system")
    shot(open_page(theme="light", **desk), "desktop-day")

    browser.close()
print("screenshots written to", os.path.abspath(args.out))
