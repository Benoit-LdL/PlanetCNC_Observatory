// The top bar and the page menu, drawn before the page is first shown. A plain script placed right
// after the menu (<nav id="pagenav">), so it runs while the page loads: the menu, and the machine
// name, status, E-stop and update dot as the previous page last showed them (kept in
// sessionStorage by nav.js). With the page transition in style.css the bar and the menu stay
// still when moving between pages; the page's own scripts take over from its first update.
// It also runs the day / night button at the top left (the theme itself is set by theme-boot.js).
(function () {
  var FILLED = { system: true };   // filled icons; the others are drawn as outlines
  var ICON = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    planing: '<path d="M3 17h18"/><path d="M3 21h18"/><path d="M6 13V5h12v8"/><path d="M9 9h6"/>',
    materials: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    // mdiServerOutline (Material Design Icons, Apache 2.0): a filled shape, see .pagelink svg.fill
    system: '<path d="M2 4.6V9.4C2 10.3 2.5 11 3.2 11H20.9C21.5 11 22.1 10.3 22.1 9.4V4.6C22 3.7 21.5 3 20.8 3H3.2C2.5 3 2 3.7 2 4.6M10 8V6H9V8H10M5 8H7V6H5V8M20 9H4V5H20V9M2 14.6V19.4C2 20.3 2.5 21 3.2 21H20.9C21.5 21 22.1 20.3 22.1 19.4V14.6C22.1 13.7 21.6 13 20.9 13H3.2C2.5 13 2 13.7 2 14.6M10 18V16H9V18H10M5 18H7V16H5V18M20 19H4V15H20V19Z"/>',
  };
  var PAGES = [
    ['dashboard', '/', 'Dashboard', 'The machine, live'],
    ['planing', '/planing', 'Planing', 'Make a program that planes rough stock flat'],
    ['materials', '/materials', 'Materials', 'The materials and planing bits used by Planing'],
    ['settings', '/settings', 'Settings', 'Machine name, camera, Files folder, Telegram, timelapse, logs'],
    ['system', '/system', 'System', 'Versions, updates, the Raspberry Pi'],
  ];
  var nav = document.getElementById('pagenav');
  if (nav) {
    var cur = nav.getAttribute('data-page');
    nav.innerHTML = PAGES.map(function (p) {
      var on = p[0] === cur;
      return '<a class="pagelink' + (on ? ' active' : '') + '" href="' + p[1] + '" data-nav="' + p[0] + '" title="' + p[3] + '"'
        + (on ? ' aria-current="page"' : '') + '><span class="ind"><svg viewBox="0 0 24 24" aria-hidden="true"'
        + (FILLED[p[0]] ? ' class="fill"' : '') + '>' + ICON[p[0]] + '</svg>'
        + (p[0] === 'system' ? '<i class="nav-dot" hidden></i>' : '') + '</span><span>' + p[2] + '</span></a>';
    }).join('')
      // The Raspberry Pi's health at the bottom of the menu, on every page (filled by nav.js)
      + '<div class="pi-gauges" hidden></div>';
  }

  // Ring gauges for the Pi's health, in every .pi-gauges box (the menu; the dashboard's Pi card
  // on a phone). pi = {gauges: [{key, label, value, unit, frac, level, tip}], power: {level, text}}
  // as nav.js makes it, or null to hide them. Shared with nav.js through window.
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  window.piGauges = function (pi) {
    var boxes = document.querySelectorAll('.pi-gauges');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      box.hidden = !pi || !pi.gauges.length;
      if (box.hidden) continue;
      var keys = pi.gauges.map(function (g) { return g.key; }).join(',');
      if (box.getAttribute('data-keys') !== keys) {
        box.setAttribute('data-keys', keys);
        box.innerHTML = pi.gauges.map(function (g) {
          return '<span class="gauge" data-g="' + g.key + '"><svg viewBox="0 0 40 40" aria-hidden="true">'
            + '<circle class="g-track" cx="20" cy="20" r="16"/><circle class="g-val" cx="20" cy="20" r="16" pathLength="100"/></svg>'
            + '<b></b><span>' + esc(g.label) + '</span></span>';
        }).join('') + '<span class="pi-power" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg></span>';
      }
      for (var k = 0; k < pi.gauges.length; k++) {
        var g = pi.gauges[k], el = box.querySelector('[data-g="' + g.key + '"]');
        el.setAttribute('data-level', g.level);
        el.title = g.tip;
        el.querySelector('.g-val').setAttribute('stroke-dasharray', Math.round(Math.max(0, Math.min(1, g.frac)) * 100) + ' 100');
        el.querySelector('b').innerHTML = esc(g.value) + '<small>' + esc(g.unit) + '</small>';
      }
      var pw = box.querySelector('.pi-power');
      pw.hidden = !pi.power || !pi.power.level;
      if (pi.power) { pw.setAttribute('data-level', pi.power.level); pw.title = pi.power.text; }
      box.title = 'Raspberry Pi' + (pi.up ? ' · ' + pi.up : '') + (pi.power && pi.power.level ? ' · ' + pi.power.text : '')
        + (box.tagName === 'A' ? ' – open the System page' : '');
    }
  };

  // Parallax: when the page scrolls, the sky behind the cards follows at a quarter of the speed,
  // so it seems far away. Only the page itself (the document, or a page's main.page), not the
  // panels inside it (G-code, console). style.css reads --sky-shift.
  var skyAt = 0, skyFrame = 0;
  document.addEventListener('scroll', function (e) {
    var t = e.target === document ? document.scrollingElement : e.target;
    if (!t || !(t === document.scrollingElement || (t.classList && t.classList.contains('page')))) return;
    skyAt = t.scrollTop;
    if (!skyFrame) {
      skyFrame = requestAnimationFrame(function () {
        skyFrame = 0;
        document.documentElement.style.setProperty('--sky-shift', (-skyAt * 0.25).toFixed(1) + 'px');
      });
    }
  }, { capture: true, passive: true });

  // Day / night
  var root = document.documentElement;
  var btn = document.getElementById('themeBtn');
  function label() {
    if (!btn) return;
    var dark = root.getAttribute('data-theme') !== 'light';
    btn.title = dark ? 'Switch to day mode' : 'Switch to night mode';
    btn.setAttribute('aria-label', btn.title);
  }
  label();
  if (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* not remembered */ }
      label();
      document.dispatchEvent(new CustomEvent('themechange', { detail: next }));   // the 3D views recolour
    });
  }

  var c = null;
  try { c = JSON.parse(sessionStorage.getItem('topbar') || 'null'); } catch (e) { /* no storage */ }
  if (!c) return;
  var name = document.getElementById('machineName');
  if (name && c.name) { name.textContent = c.name; }
  var st = document.getElementById('status');
  if (st && c.status) { st.setAttribute('data-state', c.status[0]); st.textContent = c.status[1]; }
  var dot = nav && nav.querySelector('.nav-dot');
  if (dot) dot.hidden = !c.dot;
  if (c.pi) window.piGauges(c.pi);
  if (c.estop) {
    // As last shown. Pressing it before this page's first update just asks the server, which
    // refuses when TNG isn't connected - the E-stop only ever switches TNG's E-stop on.
    var bs = document.querySelectorAll('.topbar [data-estop]');
    for (var i = 0; i < bs.length; i++) {
      bs[i].querySelector('.estop-label').textContent = c.estop.label;
      bs[i].title = c.estop.title;
      bs[i].disabled = c.estop.disabled;
      bs[i].classList.toggle('on', c.estop.on);
    }
  }
})();
