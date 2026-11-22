// Help popups: in each .set-group, the .set-help paragraphs move into a popup behind a round "?"
// next to the group's title. It opens on hover or keyboard focus, and stays open when clicked
// (for touch screens) until clicked again, Escape, or a click elsewhere. The paragraphs keep their
// ids, so text filled in by other code (folder defaults, camera addresses) still lands in them.

let open = null;   // { btn, pop, pinned }
let hideTimer = null;

function place(btn, pop) {
  const r = btn.getBoundingClientRect();
  pop.style.left = '0px';
  pop.style.top = '0px';
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left - 12), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);   // no room below: above
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function show(btn, pop, pinned = false) {
  clearTimeout(hideTimer);
  if (open && open.pop !== pop) hide();
  if (!pop.textContent.trim()) return;   // nothing to say right now (e.g. no camera)
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  place(btn, pop);
  open = { btn, pop, pinned: pinned || open?.pinned || false };
}

function hide() {
  clearTimeout(hideTimer);
  if (!open) return;
  open.pop.hidden = true;
  open.btn.setAttribute('aria-expanded', 'false');
  open = null;
}

const hideSoon = () => {
  clearTimeout(hideTimer);
  if (open && !open.pinned) hideTimer = setTimeout(hide, 180);   // time to move onto the popup
};

export function initHelp(root = document) {
  let n = 0;
  for (const group of root.querySelectorAll('.set-group')) {
    const title = group.querySelector(':scope > h3, :scope > .sys-h > h3');
    const items = [...group.querySelectorAll(':scope > .set-help')];
    if (!title || !items.length) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'help-btn';
    btn.textContent = '?';
    btn.setAttribute('aria-label', `About ${title.textContent.trim()}`);
    btn.setAttribute('aria-expanded', 'false');
    const pop = document.createElement('div');
    pop.className = 'help-pop';
    pop.id = `help-${++n}`;
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    items.forEach((el) => pop.appendChild(el));
    btn.setAttribute('aria-describedby', pop.id);
    title.appendChild(btn);
    document.body.appendChild(pop);

    btn.addEventListener('mouseenter', () => show(btn, pop));
    btn.addEventListener('mouseleave', hideSoon);
    btn.addEventListener('focus', () => show(btn, pop));
    btn.addEventListener('blur', () => { if (!pop.contains(document.activeElement)) hideSoon(); });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open?.pop === pop && open.pinned) hide();
      else { show(btn, pop, true); if (open) open.pinned = true; }
    });
    pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pop.addEventListener('mouseleave', hideSoon);
  }
  document.addEventListener('click', (e) => { if (open && !open.pop.contains(e.target)) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { open.btn.focus(); hide(); } });
  // The settings scroll: a popup left behind would point at nothing
  document.addEventListener('scroll', (e) => { if (open && !open.pop.contains(e.target)) hide(); }, true);
  window.addEventListener('resize', hide);
}
