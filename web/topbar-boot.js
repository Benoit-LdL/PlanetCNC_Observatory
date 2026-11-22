// The top bar, drawn before the page is first shown. A plain script placed right after the
// top bar, so it runs while the page loads: the menu, and the machine name, status, E-stop and
// update dot as the previous page last showed them (kept in sessionStorage by nav.js). With
// the page transition in style.css, the top bar stays still when moving between pages; the
// page's own scripts take over from its first update (about a second at most).
(function () {
  var FILLED = { system: true };   // filled icons; the others are drawn as outlines
  var ICON = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    planing: '<path d="M3 17h18"/><path d="M3 21h18"/><path d="M6 13V5h12v8"/><path d="M9 9h6"/>',
    materials: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    // mdiServerOutline (Material Design Icons, Apache 2.0): a filled shape, see .pagelink svg.fill
    system: '<path d="M2 4.6V9.4C2 10.3 2.5 11 3.2 11H20.9C21.5 11 22.1 10.3 22.1 9.4V4.6C22 3.7 21.5 3 20.8 3H3.2C2.5 3 2 3.7 2 4.6M10 8V6H9V8H10M5 8H7V6H5V8M20 9H4V5H20V9M2 14.6V19.4C2 20.3 2.5 21 3.2 21H20.9C21.5 21 22.1 20.3 22.1 19.4V14.6C22.1 13.7 21.6 13 20.9 13H3.2C2.5 13 2 13.7 2 14.6M10 18V16H9V18H10M5 18H7V16H5V18M20 19H4V15H20V19Z"/>',
  };
  var PAGES = [
    ['dashboard', '/', 'Dashboard', 'The machine, live'],
    ['planing', '/planing', 'Planing', 'Make a program that planes rough stock flat'],
    ['materials', '/materials', 'Materials', 'The cutting values per material used by Planing'],
    ['system', '/system', 'System', 'Versions, updates, reboot'],
  ];
  var nav = document.getElementById('pagenav');
  if (nav) {
    var cur = nav.getAttribute('data-page');
    nav.innerHTML = PAGES.map(function (p) {
      var on = p[0] === cur;
      return '<a class="pagelink' + (on ? ' active' : '') + '" href="' + p[1] + '" data-nav="' + p[0] + '" title="' + p[3] + '"'
        + (on ? ' aria-current="page"' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true"' + (FILLED[p[0]] ? ' class="fill"' : '') + '>' + ICON[p[0]] + '</svg><span>'
        + p[2] + '</span>' + (p[0] === 'system' ? '<i class="nav-dot" hidden></i>' : '') + '</a>';
    }).join('');
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
