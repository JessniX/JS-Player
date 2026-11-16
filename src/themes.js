// Theme presets and the code that turns a theme object into CSS variables.

const THEME_COLOR_KEYS = [
  ['bg', 'Background'],
  ['surface', 'Panels'],
  ['elevated', 'Raised'],
  ['border', 'Borders'],
  ['text', 'Text'],
  ['dim', 'Muted text'],
  ['accent', 'Accent'],
  ['accent2', 'Accent 2'],
];

const BASE_THEME = { radius: 10, alpha: 0.86, font: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif", scale: 1, bgImage: '', bgBlur: 18, css: '' };

const PRESET_THEMES = [
  { name: 'Midnight', bg: '#0d0f16', surface: '#151824', elevated: '#1e2232', border: '#2a2f42', text: '#e6e8f0', dim: '#8a90a6', accent: '#7c6cff', accent2: '#29d3c2' },
  { name: 'Synthwave', bg: '#140a1f', surface: '#1e0f2e', elevated: '#2a1640', border: '#3d2058', text: '#fbe9ff', dim: '#b58ac9', accent: '#ff3cac', accent2: '#2bd2ff', radius: 14 },
  { name: 'Ember', bg: '#120c0a', surface: '#1c1411', elevated: '#281c17', border: '#3a2a22', text: '#f6e8df', dim: '#a68d80', accent: '#ff6a2b', accent2: '#ffc93c' },
  { name: 'Forest', bg: '#0b120e', surface: '#111b15', elevated: '#18261d', border: '#24382b', text: '#e3f0e6', dim: '#86a08f', accent: '#4ade80', accent2: '#c6f36b' },
  { name: 'Ocean', bg: '#07121c', surface: '#0c1b29', elevated: '#122638', border: '#1c3650', text: '#e2f1ff', dim: '#7d9bb5', accent: '#38bdf8', accent2: '#818cf8' },
  { name: 'Rosé', bg: '#1a1216', surface: '#241a1f', elevated: '#30232a', border: '#45313b', text: '#fbeef3', dim: '#b4919f', accent: '#f9a8d4', accent2: '#fcd34d', radius: 16 },
  { name: 'Terminal', bg: '#000000', surface: '#060a06', elevated: '#0c140c', border: '#1a2e1a', text: '#b6ffb6', dim: '#4f8a4f', accent: '#39ff14', accent2: '#00e5ff', radius: 0, font: "'Cascadia Code', 'Consolas', monospace" },
  { name: 'Classic', bg: '#1b1b1b', surface: '#262626', elevated: '#303030', border: '#3c3c3c', text: '#ececec', dim: '#9a9a9a', accent: '#3d8bfd', accent2: '#5bc0de', radius: 3 },
  { name: 'Paper', bg: '#f4f1ea', surface: '#fbf9f4', elevated: '#ffffff', border: '#ddd6c8', text: '#2b2620', dim: '#7a7064', accent: '#d9480f', accent2: '#1971c2', alpha: 0.94 },
  { name: 'Snow', bg: '#eef1f6', surface: '#f8fafc', elevated: '#ffffff', border: '#d5dbe5', text: '#1b2230', dim: '#667085', accent: '#6d28d9', accent2: '#0891b2', alpha: 0.92 },
].map((t) => ({ ...BASE_THEME, ...t, preset: true }));

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const luminance = (hex) => { const [r, g, b] = hexToRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

function applyTheme(theme) {
  const t = { ...BASE_THEME, ...theme };
  const root = document.documentElement.style;
  for (const [k] of THEME_COLOR_KEYS) root.setProperty('--' + k, t[k]);
  for (const k of ['bg', 'surface', 'elevated', 'accent', 'accent2', 'text']) root.setProperty(`--${k}-rgb`, hexToRgb(t[k]).join(','));
  root.setProperty('--radius', t.radius + 'px');
  root.setProperty('--alpha', t.alpha);
  root.setProperty('--font', t.font);
  root.setProperty('--bg-blur', t.bgBlur + 'px');
  root.setProperty('--on-accent', luminance(t.accent) > 0.6 ? '#111' : '#fff');
  document.documentElement.style.fontSize = (14 * t.scale) + 'px';
  const light = luminance(t.bg) > 0.5;
  document.documentElement.dataset.light = light ? '1' : '0';
  const bd = document.getElementById('backdrop');
  if (bd) {
    bd.style.backgroundImage = t.bgImage ? `url("${window.prism.mediaUrl(t.bgImage)}")` : '';
    bd.classList.toggle('has-image', !!t.bgImage);
  }
  document.getElementById('custom-css').textContent = t.css || '';
  window.prism.windowCmd('titlebar', { symbol: t.text });
  return t;
}
