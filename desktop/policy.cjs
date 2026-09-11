'use strict';
const ORIGIN = 'https://ipfxcapital.com';
const ENTRY = ORIGIN + '/trading.html';
function trustedNavigation(raw, origin = ORIGIN) {
  try {
    const u = new URL(raw);
    return !u.username && !u.password && u.origin === origin &&
      (u.protocol === 'https:' || (origin.startsWith('http://127.0.0.1:') && u.protocol === 'http:'));
  } catch { return false; }
}
function exportAllowed(raw, filename, origin = ORIGIN) {
  try {
    const u = new URL(raw);
    return u.origin === origin && ['https:', 'blob:'].includes(u.protocol) &&
      /\.(csv|pdf|png|json|txt)$/i.test(filename) && !/[\\/\x00-\x1f:]/.test(filename);
  } catch { return false; }
}
function windowBounds(saved, area) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const width = Math.min(area.width, Math.max(800, finite(saved?.width) ? saved.width : 1440));
  const height = Math.min(area.height, Math.max(600, finite(saved?.height) ? saved.height : 920));
  const x = finite(saved?.x) ? Math.min(Math.max(saved.x,area.x),area.x+area.width-width) : area.x+(area.width-width)/2;
  const y = finite(saved?.y) ? Math.min(Math.max(saved.y,area.y),area.y+area.height-height) : area.y+(area.height-height)/2;
  return {width:Math.round(width),height:Math.round(height),x:Math.round(x),y:Math.round(y)};
}
module.exports = {ORIGIN, ENTRY, trustedNavigation, exportAllowed, windowBounds};
