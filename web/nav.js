// The page menu in the top bar, the same on every page: <nav id="pagenav" data-page="…"> is
// filled in here, with the current page highlighted. A dot on System says updates are waiting.

const ICON = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  planing: '<path d="M3 17h18"/><path d="M3 21h18"/><path d="M6 13V5h12v8"/><path d="M9 9h6"/>',
  materials: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  system: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
};

const PAGES = [
  { id: 'dashboard', href: '/', label: 'Dashboard', title: 'The machine, live' },
  { id: 'planing', href: '/planing', label: 'Planing', title: 'Make a program that planes rough stock flat' },
  { id: 'materials', href: '/materials', label: 'Materials', title: 'The cutting values per material used by Planing' },
  { id: 'system', href: '/system', label: 'System', title: 'Versions, updates, reboot' },
];

const nav = document.getElementById('pagenav');
if (nav) {
  const cur = nav.dataset.page;
  nav.innerHTML = PAGES.map((p) => `<a class="pagelink${p.id === cur ? ' active' : ''}" href="${p.href}" data-nav="${p.id}"
    title="${p.title}"${p.id === cur ? ' aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[p.id]}</svg><span>${p.label}</span>${p.id === 'system' ? '<i class="nav-dot" hidden></i>' : ''}</a>`).join('');
}

/** Show on the System item whether updates are waiting (from /api/state). */
export function navOnState(s) {
  const link = nav?.querySelector('[data-nav=system]');
  if (!link) return;
  const appN = s?.update?.behind || 0, osN = s?.os_updates || 0;
  link.querySelector('.nav-dot').hidden = !(appN || osN);
  const parts = [];
  if (appN) parts.push(`app update available (${appN} change${appN === 1 ? '' : 's'})`);
  if (osN) parts.push(`${osN} OS package update${osN === 1 ? '' : 's'}`);
  link.title = 'Versions, updates, reboot' + (parts.length ? ' – ' + parts.join(', ') : '');
}

/** For pages that don't follow the machine state themselves: check every so often. */
export function pollNav(ms = 60000) {
  const tick = async () => {
    try {
      const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
      navOnState(s);
      const name = s.machine_name;
      if (name && document.getElementById('machineName')) document.getElementById('machineName').textContent = name;
    } catch { /* next time */ }
  };
  tick();
  setInterval(tick, ms);
}
