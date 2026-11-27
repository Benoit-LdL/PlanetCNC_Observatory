// Plays the server's MJPEG stream (/api/camera.mjpg) in an <img>, reading it with fetch
// instead of giving the <img> the stream's address: a browser doesn't say when an MJPEG
// <img> gets a new frame, so this is the only way to count the frames that really arrive.
//
//   const stop = playMjpeg(img, url, { onFps, onFail });
//   onFps(fps, idleMs): about twice a second; frames per second over the last 2 s, and how
//                       long ago the last frame came (0 before the first one).
//   onFail(why):        the stream broke off or ended (not called after stop()).

const WINDOW_MS = 2000;

export function playMjpeg(img, url, { onFps = () => {}, onFail = () => {} } = {}) {
  const ctl = new AbortController();
  const arrived = [];        // times of the frames in the last WINDOW_MS
  let lastFrame = 0;
  let shown = null;          // object URL of the frame in the <img>
  let stopped = false;

  const report = () => {
    const now = performance.now();
    while (arrived.length && now - arrived[0] > WINDOW_MS) arrived.shift();
    onFps(arrived.length * 1000 / WINDOW_MS, lastFrame ? now - lastFrame : 0);
  };
  const timer = setInterval(report, 500);

  const show = (jpeg) => {
    const now = performance.now();
    arrived.push(now);
    lastFrame = now;
    const old = shown;
    shown = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
    img.src = shown;
    if (old) URL.revokeObjectURL(old);
  };

  (async () => {
    const res = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('the stream ended');
      const joined = new Uint8Array(buf.length + value.length);
      joined.set(buf);
      joined.set(value, buf.length);
      buf = joined;
      // Each part: "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n" + N bytes + "\r\n"
      for (;;) {
        const head = headerEnd(buf);
        if (head < 0) break;
        const m = /content-length:\s*(\d+)/i.exec(new TextDecoder().decode(buf.subarray(0, head)));
        if (!m) throw new Error('a frame without Content-Length');
        const size = +m[1];
        if (buf.length < head + 4 + size) break;
        show(buf.slice(head + 4, head + 4 + size));
        buf = buf.slice(head + 4 + size);
      }
    }
  })().catch((e) => {
    if (!stopped) onFail(e?.message || String(e));
  }).finally(() => {
    clearInterval(timer);
    if (!stopped) report();
  });

  return () => {
    stopped = true;
    clearInterval(timer);
    ctl.abort();
    if (shown) URL.revokeObjectURL(shown);
    img.removeAttribute('src');
  };
}

/** Index of the "\r\n\r\n" that ends a part's headers, or -1. */
function headerEnd(b) {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}
