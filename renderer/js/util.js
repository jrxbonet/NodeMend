// Small helpers shared by the renderer. No DOM state lives here.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i >= 3 ? v.toFixed(2) : i === 2 ? v.toFixed(0) : v.toFixed(0)) + ' ' + u[i];
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s); if (isNaN(d)) return String(s);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function pct(a, b) { return b ? Math.round(100 * a / b) : 0; }
function barClass(p) { return p >= 90 ? 'bad' : p >= 75 ? 'warn' : ''; }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function table(cols, rows) {
  const head = cols.map(c => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map(r => '<tr>' + cols.map(c => `<td class="${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('') + '</tr>').join('');
  return `<div style="overflow:auto"><table><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td colspan="' + cols.length + '" class="muted">none</td></tr>'}</tbody></table></div>`;
}

// Minimal inline SVG icon set (stroke icons, 24-unit viewBox). Use icon('name') or data-icon="name".
const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  broom: '<path d="M19 3l-7 7"/><path d="M14 8l2 2"/><path d="M4.5 21c0-4 2-7.5 5.5-9.5L14 15.5C12 19 8.5 21 4.5 21z"/><path d="M8 16l1.5 1.5"/>',
  pulse: '<path d="M22 12h-4l-3 8-4-16-3 8H2"/>',
  upload: '<circle cx="12" cy="12" r="9"/><path d="M12 16V8"/><path d="M8.5 11.5L12 8l3.5 3.5"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2"/><path d="M14 4c3-1 6-1 7 0 1 1 1 4 0 7-2 4-6 7-9 8l-4-4c1-3 4-7 8-9z"/><circle cx="15" cy="9" r="1.5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
  disk: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v6M12 15v6"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 7v10M11 7v10M15 7v10M19 7v10"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L13 18a2 2 0 0 1-3 0l-1-1a2 2 0 0 1 0-3l6.7-6.7z"/><path d="M3 21l6-6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M10.8 11.2L20 2"/><path d="M16 6l3 3"/><path d="M13 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path d="M12 15v2"/>'
};
function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
function applyIcons(root = document) {
  $$('[data-icon]', root).forEach(el => { if (!el.querySelector('svg.ic')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon)); });
}
function gauge(p, label, cls = '') {
  return `<div class="gauge ${cls || barClass(p)}" style="--p:${p}"><span>${label}</span></div>`;
}
