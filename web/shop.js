// Shop devices: switches, lights and fans in Home Assistant (a smart plug for the dust extraction, the
// lights, an air filter), chosen in Settings > Home Assistant and switched from the dashboard's Shop devices
// card. The server reads their state (state.shop) and switches them (/api/shop/switch); see ShopDevices in
// server.py. Settings uses the icons and the guess below.

import { sentence, UNREACHABLE } from './msg.js';

/** The icons a device can have (server.py SHOP_ICONS): a name for Settings, and the drawing. */
export const SHOP_ICONS = {
  plug: { label: 'Plug', svg: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>' },
  fan: { label: 'Fan', svg: '<g class="shop-spin"><circle cx="12" cy="12" r="1.5"/>'
    + ['0', '120', '240'].map((a) => `<path transform="rotate(${a} 12 12)" d="M12 10.2C8.6 8.6 8 3.2 12.5 2.6c4.2-.5 4.6 5-.5 7.6"/>`).join('')
    + '</g>' },
  light: { label: 'Light', svg: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>' },
  air: { label: 'Air filter', svg: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/>' },
  vacuum: { label: 'Dust extraction', svg: '<rect x="3" y="11" width="10" height="8" rx="3"/><path d="M5 11V9h6v2"/><path d="M8 9V6a2 2 0 0 1 2-2h7a3 3 0 0 1 3 3v14"/><path d="M17 21h5"/><path d="M5 21h.01M11 21h.01"/>' },
};

export const shopIcon = (key) => `<svg viewBox="0 0 24 24" aria-hidden="true">${(SHOP_ICONS[key] || SHOP_ICONS.plug).svg}</svg>`;

/** An icon for a newly added device, from its entity id and name. */
export function guessIcon(entity, name = '') {
  const t = `${entity} ${name}`.toLowerCase();
  if (/filter|purif|air_?clean/.test(t)) return 'air';
  if (/vac|extract|dust|cyclone|suction/.test(t)) return 'vacuum';
  if (entity.startsWith('light.') || /light|lamp|led/.test(t)) return 'light';
  if (entity.startsWith('fan.') || /fan|vent/.test(t)) return 'fan';
  return 'plug';
}

// ---------------------------------------------------------------- the dashboard's card

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PENDING_FOR = 8000;   // after a switch, wait this long for Home Assistant to show the new state

let shape = '';             // the devices drawn (entity, name, icon), to redraw only when they change
const pending = new Map();  // entity -> { on, until }: switched here, new state not seen yet
let last = null;            // the last state.shop

function stateText(d, p) {
  if (p) return p.on ? 'Turning on…' : 'Turning off…';
  switch (d.state) {
    case 'on': return d.pct != null ? `On · ${d.pct} %` : 'On';
    case 'off': return 'Off';
    case null: case undefined: return '…';
    case 'missing': return 'Not found in Home Assistant';
    case 'unavailable': return 'Unavailable';
    default: return d.state[0].toUpperCase() + d.state.slice(1);
  }
}

function draw(shop) {
  const list = $('shopDevs');
  const now = Date.now();
  for (const [eid, p] of pending) {
    const d = shop.devices.find((x) => x.entity === eid);
    if (!d || now > p.until || d.state === (p.on ? 'on' : 'off')) pending.delete(eid);
  }
  const want = JSON.stringify(shop.devices.map((d) => [d.entity, d.name, d.icon]));
  if (want !== shape) {
    shape = want;
    list.innerHTML = shop.devices.map((d) => `<label class="shop-dev" data-entity="${esc(d.entity)}" data-icon="${esc(d.icon)}">`
      + `<span class="shop-ic">${shopIcon(d.icon)}</span>`
      + `<span class="shop-txt"><b>${esc(d.name)}</b><small></small></span>`
      + `<input type="checkbox" role="switch" aria-label="${esc(d.name)}"></label>`).join('');
  }
  for (const row of list.children) {
    const d = shop.devices.find((x) => x.entity === row.dataset.entity);
    if (!d) continue;
    const p = pending.get(d.entity);
    const input = row.querySelector('input');
    const usable = !shop.error && (d.state === 'on' || d.state === 'off');
    input.checked = p ? p.on : d.state === 'on';
    input.disabled = !usable || !!p;
    row.dataset.state = p ? 'pending' : usable ? d.state : 'off';
    row.classList.toggle('bad', !p && !usable && d.state != null);
    row.querySelector('small').textContent = shop.error ? '–' : stateText(d, p);
    row.title = d.entity;
  }
  const msg = $('shopMsg');
  if (shop.error) {
    msg.textContent = sentence(shop.error);   // the server's messages name Home Assistant
    msg.className = 'shop-msg err';
  } else if (msg.classList.contains('err')) {
    msg.textContent = '';
    msg.className = 'shop-msg';
  }
}

/** state.shop on the dashboard: the card, hidden while there are no devices (or no Home Assistant). */
export function shopOnState(s) {
  const card = $('shopCard');
  if (!card || !('shop' in s)) return;
  last = s.shop;
  card.hidden = !last;
  if (last) draw(last);
}

async function toggle(input) {
  const row = input.closest('.shop-dev');
  const entity = row.dataset.entity, on = input.checked;
  pending.set(entity, { on, until: Date.now() + PENDING_FOR });
  if (last) draw(last);
  const msg = $('shopMsg');
  let res;
  try {
    const r = await fetch('/api/shop/switch', {
      method: 'POST', headers: { 'X-CNC-Control': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity, on }),
    });
    res = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  } catch {
    res = { ok: false, message: UNREACHABLE };
  }
  if (!res.ok) {
    pending.delete(entity);
    msg.textContent = sentence(`Could not switch ${row.querySelector('b').textContent}: ${res.message}`);
    msg.className = 'shop-msg err';
    if (last) draw(last);
  } else if (msg.classList.contains('err')) {
    msg.textContent = '';
    msg.className = 'shop-msg';
  }
}

export function initShop() {
  $('shopDevs')?.addEventListener('change', (e) => {
    if (e.target.matches('input[type=checkbox]')) toggle(e.target);
  });
}
