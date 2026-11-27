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
    surfacing: '<path d="M3 17h18"/><path d="M3 21h18"/><path d="M6 13V5h12v8"/><path d="M9 9h6"/>',
    materials: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    // mdiServerOutline (Material Design Icons, Apache 2.0): a filled shape, see .pagelink svg.fill
    system: '<path d="M2 4.6V9.4C2 10.3 2.5 11 3.2 11H20.9C21.5 11 22.1 10.3 22.1 9.4V4.6C22 3.7 21.5 3 20.8 3H3.2C2.5 3 2 3.7 2 4.6M10 8V6H9V8H10M5 8H7V6H5V8M20 9H4V5H20V9M2 14.6V19.4C2 20.3 2.5 21 3.2 21H20.9C21.5 21 22.1 20.3 22.1 19.4V14.6C22.1 13.7 21.6 13 20.9 13H3.2C2.5 13 2 13.7 2 14.6M10 18V16H9V18H10M5 18H7V16H5V18M20 19H4V15H20V19Z"/>',
  };
  var PAGES = [
    ['dashboard', '/', 'Dashboard', 'The machine, live'],
    ['surfacing', '/surfacing', 'Surfacing', 'Make a program that surfaces rough stock flat'],
    ['materials', '/materials', 'Stock &amp; Bit', 'The stocks and surfacing bits used by Surfacing'],
    ['settings', '/settings', 'Settings', 'Machine name, camera, Files folder, tool in the 3D view, Telegram and timelapse, MQTT, air quality, logs'],
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
      // The air quality (when set up) and the Raspberry Pi's health at the bottom of the menu, on every
      // page (filled by nav.js)
      + '<div class="air-gauges" hidden></div><div class="pi-gauges" hidden></div>';
  }

  // Ring gauges for the Pi's health, in every .pi-gauges box (the menu; the dashboard's Pi card
  // on a phone). pi = {gauges: [{key, label, value, unit, frac, level, tip}], power: {level, text}}
  // as nav.js makes it, or null to hide them. Shared with nav.js through window.
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ringHtml(g) {
    return '<span class="gauge" data-g="' + g.key + '"><svg viewBox="0 0 40 40" aria-hidden="true">'
      + '<circle class="g-track" cx="20" cy="20" r="16"/><circle class="g-val" cx="20" cy="20" r="16" pathLength="100"/></svg>'
      + '<b></b><span>' + esc(g.label) + '</span></span>';
  }
  /** Draw the rings of `gauges` in `box` (rebuilt only when the set of rings changes); `before` and
   *  `after` are extra HTML around them, put in when the box is rebuilt. */
  function fillRings(box, gauges, before, after) {
    var keys = gauges.map(function (g) { return g.key; }).join(',');
    if (box.getAttribute('data-keys') !== keys) {
      box.setAttribute('data-keys', keys);
      box.innerHTML = before + gauges.map(ringHtml).join('') + after;
    }
    for (var k = 0; k < gauges.length; k++) {
      var g = gauges[k], el = box.querySelector('[data-g="' + g.key + '"]');
      el.setAttribute('data-level', g.level);
      el.title = g.tip;
      el.querySelector('.g-val').setAttribute('stroke-dasharray', Math.round(Math.max(0, Math.min(1, g.frac)) * 100) + ' 100');
      el.querySelector('b').innerHTML = esc(g.value) + '<small>' + esc(g.unit) + '</small>';
    }
  }
  window.piGauges = function (pi) {
    var boxes = document.querySelectorAll('.pi-gauges');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      box.hidden = !pi || !pi.gauges.length;
      if (box.hidden) continue;
      fillRings(box, pi.gauges, '<span class="air-cap pi-cap">Pi</span>', '<span class="pi-power" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg></span>');
      var pw = box.querySelector('.pi-power');
      pw.hidden = !pi.power || !pi.power.level;
      if (pi.power) { pw.setAttribute('data-level', pi.power.level); pw.title = pi.power.text; }
      box.title = 'Raspberry Pi' + (pi.up ? ' · ' + pi.up : '') + (pi.power && pi.power.level ? ' · ' + pi.power.text : '')
        + (box.tagName === 'A' ? ' – open the System page' : '');
    }
  };

  // The air quality rings, in every .air-gauges box (the menu; on a phone, the panel of the air button in
  // the top bar). air = {gauges: [...as above], status: {level, text}, climate: '21° 47 %', title, fresh}
  // as nav.js makes it, or null to hide them.
  window.airGauges = function (air) {
    airButton(air);   // first: its panel holds a box of rings, filled below
    var boxes = document.querySelectorAll('.air-gauges');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      box.hidden = !air;
      if (!air) continue;
      fillRings(box, air.gauges, '<span class="air-cap"><i></i>Air</span>', '<span class="air-climate"></span>');
      var cap = box.querySelector('.air-cap');
      cap.setAttribute('data-level', air.status.level);
      cap.title = air.status.text;
      var clim = box.querySelector('.air-climate');
      clim.innerHTML = climateHtml(air, ' ');   // side by side, on one line
      clim.title = air.title;
      // The rings explain themselves in a popup (below), instead of a browser tooltip
      for (var k = 0; k < air.gauges.length; k++) {
        var g = air.gauges[k], el = box.querySelector('[data-g="' + g.key + '"]');
        if (!AIR_INFO[g.key]) continue;
        el.removeAttribute('title');
        el.tabIndex = 0;
        el.setAttribute('aria-label', g.tip);
        el.airGauge = g;
      }
      // New values while its popup is open: update it (only then: a closed popup stays closed)
      if (gaugePop && !gaugePop.box.hidden && gaugePop.el.isConnected && box.contains(gaugePop.el)) showGaugePop(gaugePop.el);
    }
    airAlert(air);
  };

  // ---- The air alert: on the dashboard and the Surfacing page, a small box next to the air rings while a
  // value is raised (amber) or high (red), saying which. Hazard tape around it; blinking when one is high.
  // x hides it until what's over changes (another sensor, or one going from raised to high).
  var ALERT_PAGES = { dashboard: true, surfacing: true };
  var alertEl = null, alertNow = '', alertHidden = '';
  function airAlert(air) {
    var nav = document.getElementById('pagenav');
    if (!nav || !ALERT_PAGES[nav.getAttribute('data-page')]) return;
    var over = air && air.fresh ? air.gauges.filter(function (g) { return g.level; }) : [];
    alertNow = over.map(function (g) { return g.key + ':' + g.level; }).join(',');
    if (!over.length) alertHidden = '';
    var high = over.some(function (g) { return g.level === 'err'; });
    var on = over.length && alertNow !== alertHidden;
    // On a phone the same alert is hazard tape around the air button (its panel holds the message)
    if (airBtn) {
      airBtn.classList.toggle('alert', !!on);
      airBtn.classList.toggle('high', !!on && high);
    }
    if (!on) {
      if (alertEl) alertEl.hidden = true;
      return;
    }
    if (!alertEl) {
      alertEl = document.createElement('div');
      alertEl.className = 'air-alert';
      alertEl.setAttribute('role', 'alert');
      alertEl.addEventListener('click', function (e) {
        if (!e.target.closest('.air-alert-x')) return;
        alertHidden = alertNow;
        alertEl.hidden = true;
        if (airBtn) airBtn.classList.remove('alert', 'high');
      });
    }
    alertEl.classList.toggle('high', high);
    alertEl.innerHTML = '<div class="air-alert-in"><b class="air-alert-head">⚠ Air quality ' + (high ? 'high' : 'raised')
      + '</b><button class="air-alert-x" type="button" title="Hide until something changes" aria-label="Hide">×</button><ul>'
      + over.map(function (g) {
        var unit = AIR_INFO[g.key] && AIR_INFO[g.key].unit;
        return '<li class="' + g.level + '"><b>' + esc(g.label) + '</b> ' + esc(g.value) + (unit ? ' ' + unit : '')
          + ' <span>' + (g.level === 'err' ? 'high' : 'raised') + '</span></li>';
      }).join('') + '</ul></div>';
    alertEl.hidden = false;
    placeAirAlert();
  }
  // Beside the menu's air rings; on a phone (no rings in the menu) in the air button's panel, above its rings
  function placeAirAlert() {
    if (!alertEl || alertEl.hidden) return;
    var rail = document.querySelector('.rail .air-gauges');
    if (rail && rail.offsetParent) {
      if (alertEl.parentNode !== document.body) document.body.appendChild(alertEl);
      alertEl.classList.remove('inline');
      var r = rail.getBoundingClientRect();
      alertEl.style.left = Math.round(r.right + 8) + 'px';
      alertEl.style.top = Math.round(Math.max(8, Math.min(r.top, innerHeight - alertEl.offsetHeight - 8))) + 'px';
    } else if (airPanel) {
      var rings = airPanel.querySelector('.air-gauges');
      if (alertEl.nextElementSibling !== rings) airPanel.insertBefore(alertEl, rings);
      alertEl.classList.add('inline');
      alertEl.style.left = alertEl.style.top = '';
    }
  }
  addEventListener('resize', placeAirAlert);

  // ---- The air button in the top bar, on a phone (the menu there is a bottom bar, without the air rings).
  // Its colour is the worst reading's (as the dot next to Air); hazard tape around it while the air alert is
  // on (above). A tap opens a panel under the top bar: status, temperature and humidity, the alert, the rings.
  var AIR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/>'
    + '<path d="M3 16h7"/></svg>';
  var airBtn = null, airPanel = null;
  function airButton(air) {
    var bar = document.querySelector('.topbar');
    if (!bar) return;
    if (!airBtn) {
      airBtn = document.createElement('button');
      airBtn.type = 'button';
      airBtn.className = 'air-btn';
      airBtn.setAttribute('aria-expanded', 'false');
      airBtn.innerHTML = AIR_ICON;
      bar.insertBefore(airBtn, bar.querySelector('.status'));
      airPanel = document.createElement('div');
      airPanel.className = 'air-panel';
      airPanel.hidden = true;
      airPanel.setAttribute('role', 'dialog');
      airPanel.setAttribute('aria-label', 'Air quality');
      airPanel.innerHTML = '<div class="sys-head"><h2>Air quality</h2><span class="sys-up air-panel-clim"></span>'
        + '<span class="sys-power air-panel-status"></span></div><div class="air-gauges inline"></div>';
      document.body.appendChild(airPanel);
      airBtn.addEventListener('click', function () { openAirPanel(airPanel.hidden); });
      document.addEventListener('click', function (e) {   // a tap elsewhere closes it
        if (!airPanel.hidden && !airPanel.contains(e.target) && !airBtn.contains(e.target)) openAirPanel(false);
      });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') openAirPanel(false); });
    }
    airBtn.hidden = !air;
    if (!air) { openAirPanel(false); return; }
    airBtn.setAttribute('data-level', air.status.level);
    airBtn.title = 'Air quality: ' + air.status.text;
    airBtn.setAttribute('aria-label', airBtn.title);
    var st = airPanel.querySelector('.air-panel-status');
    st.setAttribute('data-level', air.status.level);
    st.textContent = air.status.text.split(':')[0];
    st.title = air.status.text;
    airPanel.querySelector('.air-panel-clim').innerHTML = climateHtml(air, ' · ');
  }
  function openAirPanel(open) {
    if (!airPanel) return;
    airPanel.hidden = !open;
    airBtn.setAttribute('aria-expanded', String(!!open));
    if (open) {
      airPanel.style.top = Math.round(document.querySelector('.topbar').getBoundingClientRect().bottom + 8) + 'px';
      placeAirAlert();
    }
  }

  // ---- What an air-quality value means, in a popup on the ring (hover, focus, or a tap on a phone).
  // VOC and NOx are Sensirion indexes: they compare the air with the room's own recent past (VOC 100 =
  // the average of the last 24 h, NOx 1 = clean air), so they show events, not health limits; the band
  // edges are a rule of thumb (the same as the rings' amber and red). Dust is measured (µg/m³), so it
  // has health guidelines: WHO 2021, which are 24-hour and yearly averages, not limits for one reading.
  var LEARN = 'A rule of thumb, not a health limit. Learns the room in about a day after a first start.';
  var AIR_INFO = {
    voc: {
      name: 'VOC index', unit: '',
      text: 'Compared with this room\'s last 24 hours (= 100). Rises with finishes, glue, paint, solvents or cooking.',
      bands: [[1, 'Normal or better than usual'], [101, 'Slightly raised'], [150, 'Clearly raised: ventilate'],
              [250, 'High'], [400, 'Very high: ventilate now and find the source']],
      foot: LEARN, source: 'Sensirion VOC index',
    },
    nox: {
      name: 'NOx index', unit: '',
      text: '1 is clean air. Rises with a gas stove, a fire or candle, or traffic fumes.',
      bands: [[1, 'Normal'], [20, 'Noticeable: ventilate'], [150, 'High'], [300, 'Very high']],
      foot: LEARN, source: 'Sensirion NOx index',
    },
    pm25: {
      name: 'PM2.5', unit: 'µg/m³',
      text: 'Fine dust from sanding and cutting; it goes deep into the lungs.',
      // From the WHO 2021 guidelines (5 a year, 15 a day) and the ring's red (50): measured values, with decimals
      bands: [[0, 'Clean: below the WHO yearly guideline'], [5, 'Fine: below the WHO 24-hour guideline'],
              [15, 'Raised: run the dust extraction, ventilate'], [50, 'High: dust extraction and a mask']],
      measured: true, who: [15, 5],
    },
    pm10: {
      name: 'PM10', unit: 'µg/m³',
      text: 'Coarser dust from sawing and routing (PM2.5 included).',
      bands: [[0, 'Clean: below the WHO yearly guideline'], [15, 'Fine: below the WHO 24-hour guideline'],
              [45, 'Raised: run the dust extraction, ventilate'], [100, 'High: dust extraction and a mask']],
      measured: true, who: [45, 15],
    },
  };

  var gaugePop = null;   // {el: the ring, box: the popup}
  // bands: [first value, meaning]. The indexes (VOC, NOx) are whole numbers up to 500, shown as 1–100, 101–149...;
  // dust is measured with decimals, shown as 0–5, 5–15... (a value on the edge is in the higher range, as for the rings)
  function bandOf(info, v) {
    var i = info.bands.length - 1;
    while (i > 0 && (info.measured ? v : Math.round(v)) < info.bands[i][0]) i--;
    return i;
  }
  function gaugePopHtml(g) {
    var info = AIR_INFO[g.key], v = g.v;
    var num = function (x) { return x == null ? '–' : x < 10 && info.unit ? x.toFixed(1) : String(Math.round(x)); };
    var level = function (from) { return g.errAt != null && from >= g.errAt ? 'err' : g.warnAt != null && from >= g.warnAt ? 'warn' : ''; };
    var h = '<b class="gp-head">' + esc(info.name) + ' <span>' + (v == null ? 'no value' : esc(num(v)) + (info.unit ? ' ' + info.unit : ''))
      + '</span></b>';
    // The table first, under the title: where the value is, at a glance; the explanation after it
    if (info.bands) {
      var on = v == null ? -1 : bandOf(info, v);
      h += '<table class="gp-bands">';
      for (var i = 0; i < info.bands.length; i++) {
        var from = info.bands[i][0], next = i + 1 < info.bands.length ? info.bands[i + 1][0] : null;
        var range = info.measured ? from + (next == null ? '+' : '–' + next) : from + '–' + (next == null ? 500 : next - 1);
        h += '<tr class="' + (i === on ? 'on ' : '') + level(from) + '"><td>' + range + '</td><td>' + esc(info.bands[i][1]) + '</td></tr>';
      }
      h += '</table>';
    }
    h += '<p>' + esc(info.text) + '</p>';
    // One footnote: the caveat, PM1 / PM4 with the dust, and the source last
    var foot = info.who ? 'Short peaks while sanding are normal: the guidelines are averages.' + (g.also ? ' ' + g.also + '.' : '')
      + ' Source: WHO 2021 guidelines, ' + info.who[0] + ' ' + info.unit + ' over 24 h, ' + info.who[1] + ' over a year.'
      : info.foot + ' Source: ' + info.source + '.';
    h += '<p class="gp-foot">' + esc(foot) + '</p>';
    return h;
  }
  function showGaugePop(el) {
    var g = el.airGauge;
    if (!g) return;
    if (!gaugePop) {
      var box = document.createElement('div');
      box.className = 'help-pop gauge-pop';
      box.setAttribute('role', 'tooltip');
      document.body.appendChild(box);
      gaugePop = { el: el, box: box };
    }
    gaugePop.el = el;
    var pop = gaugePop.box;
    pop.innerHTML = gaugePopHtml(g);
    pop.hidden = false;
    // Beside the ring (the menu), or below it when there's no room (the phone's Air card)
    var r = el.getBoundingClientRect(), w = pop.offsetWidth, ph = pop.offsetHeight, gap = 10;
    var x = r.right + gap + w <= innerWidth - 8 ? r.right + gap : Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8));
    var y = x === r.right + gap ? r.top + r.height / 2 - ph / 2 : (r.bottom + gap + ph <= innerHeight - 8 ? r.bottom + gap : r.top - gap - ph);
    pop.style.left = Math.round(x) + 'px';
    pop.style.top = Math.round(Math.max(8, Math.min(y, innerHeight - ph - 8))) + 'px';
  }
  function hideGaugePop() { if (gaugePop) gaugePop.box.hidden = true; }
  var airRing = function (t) { return t && t.closest ? t.closest('.air-gauges .gauge') : null; };
  document.addEventListener('mouseover', function (e) { var el = airRing(e.target); if (el && el.airGauge) showGaugePop(el); });
  document.addEventListener('mouseout', function (e) { if (airRing(e.target) && !airRing(e.relatedTarget)) hideGaugePop(); });
  document.addEventListener('focusin', function (e) { var el = airRing(e.target); if (el) showGaugePop(el); else hideGaugePop(); });
  document.addEventListener('click', function (e) {   // a tap on a phone: show it; elsewhere: hide it
    var el = airRing(e.target);
    if (el && el.airGauge) showGaugePop(el); else hideGaugePop();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideGaugePop(); });
  addEventListener('scroll', hideGaugePop, true);
  addEventListener('resize', hideGaugePop);

  // The temperature and humidity, each after its icon (a thermometer, a drop), joined by `sep`
  // (a line break in the narrow menu). The menu kept from an older version may only have the text.
  var CLIMATE_ICON = {
    temp: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
    hum: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
  };
  function climateHtml(air, sep) {
    if (air.temp === undefined) return esc((air.climate || '').split('\n').join(sep));
    return ['temp', 'hum'].filter(function (k) { return air[k]; }).map(function (k) {
      return '<span class="clim"><svg viewBox="0 0 24 24" aria-hidden="true">' + CLIMATE_ICON[k] + '</svg>' + esc(air[k]) + '</span>';
    }).join(esc(sep));
  }
  window.climateHtml = climateHtml;

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
  if (c.air) window.airGauges(c.air);
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
