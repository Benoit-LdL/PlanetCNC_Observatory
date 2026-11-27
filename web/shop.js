// Shop devices: switches, lights and fans in Home Assistant (a smart plug for the dust extraction, the
// lights, an air filter), chosen in Settings > Home Assistant and switched from the top bar on every page
// (topbar-boot.js draws and runs them; ShopDevices in server.py reads and switches them). This is what
// Settings needs: the icons (drawn by topbar-boot.js, which runs first) and a guess for a new device's icon.

/** The icons a device can have (server.py SHOP_ICONS): {key: {label, svg}}. */
export const SHOP_ICONS = window.SHOP_ICONS;

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
