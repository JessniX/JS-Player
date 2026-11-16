// Image viewer: zoom/pan/rotate/flip, slideshow, filmstrip and info panel.
// Loaded after app.js and shares its globals (S, $, api, load, osd, ...).

const IMG_EXT = new Set([
  'jpg', 'jpeg', 'jfif', 'pjpeg', 'png', 'apng', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
  'tif', 'tiff', 'heic', 'heif', 'tga', 'psd', 'dds', 'exr', 'hdr', 'pcx', 'ppm', 'pgm', 'pbm', 'pnm', 'sgi', 'jp2', 'j2k', 'jxl', 'qoi', 'xbm', 'dpx',
]);
const isImagePath = (p) => IMG_EXT.has((p.split('.').pop() || '').toLowerCase());

const IV = {
  active: false, nat: { w: 0, h: 0 }, scale: 1, x: 0, y: 0, rot: 0, flip: 1, fit: true,
  converted: false, slideshow: false, slideTimer: null, dir: 1, token: 0, src: '',
};
const STRIP_H = 84;
const photo = $('#photo');
const pwrap = $('#photo-wrap');
const photoBg = document.createElement('div');
photoBg.id = 'photo-bg';
pwrap.prepend(photoBg);

// ------------------------------------------------------------ enter / exit
function enterImageMode() {
  IV.active = true;
  document.body.classList.add('image-mode');
  stage.classList.add('has-image');
  applyImageSettings();
}
function exitImageMode() {
  if (!IV.active) return;
  IV.active = false;
  IV.token++;
  toggleSlideshow(false, true);
  document.body.classList.remove('image-mode');
  stage.classList.remove('has-image', 'strip-on');
  photo.removeAttribute('src');
  photo.classList.remove('loaded');
  $('#img-info').classList.add('hidden');
}
function applyImageSettings() {
  stage.classList.remove('bg-black', 'bg-checker', 'bg-blur');
  if (S.img.bg !== 'theme') stage.classList.add('bg-' + S.img.bg);
  $('#img-strip-btn').classList.toggle('on', S.img.strip);
  $('#img-info-btn').classList.toggle('on', S.img.info);
  if (IV.active) {
    renderFilmstrip();
    $('#img-info').classList.toggle('hidden', !S.img.info);
    if (IV.fit && IV.nat.w) fitView(false);
  }
}

// ------------------------------------------------------------ loading
function loadImage(item) {
  const token = ++IV.token;
  enterImageMode();
  IV.converted = false;
  photo.classList.remove('loaded', 'enter-fade', 'enter-zoom', 'enter-slide');
  photo.onload = () => {
    if (token !== IV.token) return;
    let w = photo.naturalWidth, h = photo.naturalHeight;
    if (!w || !h) { w = 1024; h = 768; } // e.g. SVG without a size
    IV.nat = { w, h };
    photo.style.width = w + 'px';
    photo.style.height = h + 'px';
    IV.rot = 0;
    IV.flip = 1;
    fitView(false);
    photoBg.style.backgroundImage = `url("${photo.currentSrc}")`;
    const t = S.img.transition;
    if (t !== 'none') {
      photo.style.setProperty('--slide-from', IV.dir < 0 ? '-60px' : '60px');
      void photo.offsetWidth; // restart animation
      photo.classList.add('enter-' + t);
    }
    photo.classList.add('loaded');
    if (!item.dims) { item.dims = `${w}×${h}`; renderPlaylist(); save(); }
    updateCounter();
    updateImageInfo();
    armSlideshow();
    preloadNeighbors();
  };
  photo.onerror = async () => {
    if (token !== IV.token) return;
    if (IV.converted) { showError(`Can't open “${item.name}”`); armSlideshow(); return; }
    IV.converted = true;
    showBusy('Converting image…');
    const r = await api.convertImage(item.path);
    hideBusy();
    if (token !== IV.token) return;
    if (!r || r.error) { showError(r?.error || `Can't open “${item.name}”`); armSlideshow(); return; }
    photo.src = api.mediaUrl(r);
  };
  photo.src = api.mediaUrl(item.path);
  renderFilmstrip();
  updateCounter();
}

function imageIndices() {
  const out = [];
  S.playlist.forEach((it, i) => { if (isImagePath(it.path)) out.push(i); });
  return out;
}
function nextImageIndex(dir, wrap = true) {
  const idx = imageIndices();
  if (!idx.length) return -1;
  if (S.shuffle && idx.length > 1 && IV.slideshow) {
    let r;
    do r = idx[Math.floor(Math.random() * idx.length)]; while (r === S.index);
    return r;
  }
  const pos = idx.indexOf(S.index);
  let n = pos + dir;
  if (n >= idx.length) n = wrap ? 0 : -1;
  if (n < 0) n = wrap ? idx.length - 1 : -1;
  return n < 0 ? -1 : idx[n];
}
function stepImage(dir) {
  const i = nextImageIndex(dir);
  if (i >= 0 && i !== S.index) load(i);
}
function preloadNeighbors() {
  for (const d of [1, -1]) {
    const i = nextImageIndex(d);
    if (i >= 0 && i !== S.index) {
      const p = S.playlist[i].path;
      if (!/\.(tiff?|heic|heif|tga|psd|dds|exr|hdr|pcx|p[pgbn]m|sgi|jp2|j2k|jxl|qoi|xbm|dpx)$/i.test(p)) new Image().src = api.mediaUrl(p);
    }
  }
}
function updateCounter() {
  const idx = imageIndices();
  const pos = idx.indexOf(S.index) + 1;
  $('#img-counter').textContent = `${pos} / ${idx.length}${IV.nat.w ? `  ·  ${IV.nat.w}×${IV.nat.h}` : ''}`;
}

// ------------------------------------------------------------ view (zoom / pan / rotate)
const stripShown = () => stage.classList.contains('strip-on');
// space kept clear at the bottom for the toolbar (and filmstrip) when fitting
const reserved = () => 64 + (stripShown() ? STRIP_H : 0);
function fitScale() {
  const W = pwrap.clientWidth, H = pwrap.clientHeight - reserved();
  const sideways = Math.abs(IV.rot % 180) === 90;
  const w = sideways ? IV.nat.h : IV.nat.w, h = sideways ? IV.nat.w : IV.nat.h;
  if (!w || !h || W <= 0 || H <= 0) return 1;
  const s = Math.min(W / w, H / h) * 0.98;
  return S.img.upscale ? s : Math.min(1, s);
}
function fitView(smooth = true) {
  IV.fit = true;
  IV.scale = fitScale();
  IV.x = 0;
  IV.y = -reserved() / 2;
  applyView(smooth);
}
function applyView(smooth) {
  photo.classList.toggle('smooth', !!smooth);
  photo.style.transform = `translate(-50%, -50%) translate(${IV.x}px, ${IV.y}px) rotate(${IV.rot}deg) scale(${IV.scale * IV.flip}, ${IV.scale})`;
  photo.classList.toggle('pixelated', IV.scale >= 3);
  $('#img-zoom').textContent = IV.fit ? 'Fit' : Math.round(IV.scale * 100) + '%';
  if (S.img.info) updateZoomInfo();
}
function zoomTo(scale, cx = 0, cy = 0, smooth = true) {
  const ns = Math.max(0.02, Math.min(50, scale));
  const k = ns / IV.scale;
  IV.x = cx - (cx - IV.x) * k;
  IV.y = cy - (cy - IV.y) * k;
  IV.scale = ns;
  IV.fit = false;
  applyView(smooth);
}
function pointFromEvent(e) {
  if (!e || e.clientX == null) return [0, 0];
  const r = pwrap.getBoundingClientRect();
  return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2];
}
function zoomBy(f, e) {
  const [cx, cy] = pointFromEvent(e);
  zoomTo(IV.scale * f, cx, cy, !e || e.type !== 'wheel');
}
function toggleZoom(e) {
  const fs = fitScale();
  const [cx, cy] = pointFromEvent(e);
  if (IV.fit || Math.abs(IV.scale - fs) < 0.001) zoomTo(Math.abs(fs - 1) < 0.001 ? 2 : 1, cx, cy, true);
  else fitView(true);
}
function rotate(d) {
  IV.rot += d;
  if (IV.fit) fitView(true); else applyView(true);
  osd(`Rotated ${((IV.rot % 360) + 360) % 360}°`);
}
function flip() {
  IV.flip *= -1;
  applyView(true);
  osd(IV.flip < 0 ? 'Flipped' : 'Unflipped');
}

// panning
let pan = null;
pwrap.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !IV.active) return;
  pan = { sx: e.clientX, sy: e.clientY, x: IV.x, y: IV.y, moved: false };
  pwrap.setPointerCapture(e.pointerId);
});
pwrap.addEventListener('pointermove', (e) => {
  if (!pan) return;
  const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
  if (!pan.moved && Math.hypot(dx, dy) < 4) return;
  pan.moved = true;
  pwrap.classList.add('panning');
  IV.x = pan.x + dx;
  IV.y = pan.y + dy;
  IV.fit = false;
  applyView(false);
});
const endPan = () => { pan = null; pwrap.classList.remove('panning'); };
pwrap.addEventListener('pointerup', endPan);
pwrap.addEventListener('pointercancel', endPan);
new ResizeObserver(() => { if (IV.active && IV.fit && IV.nat.w) fitView(false); }).observe(pwrap);

// ------------------------------------------------------------ slideshow
function toggleSlideshow(force, quiet) {
  const on = force ?? !IV.slideshow;
  if (on && imageIndices().length < 2) { if (!quiet) osd('Add more images for a slideshow'); return; }
  IV.slideshow = on;
  clearTimeout(IV.slideTimer);
  $('#img-slide').classList.toggle('on', on);
  if (on) armSlideshow();
  if (!quiet) osd(on ? `Slideshow · ${S.img.interval}s per image` : 'Slideshow stopped');
  syncPlayUI();
}
function armSlideshow() {
  clearTimeout(IV.slideTimer);
  if (!IV.slideshow || !IV.active) return;
  IV.slideTimer = setTimeout(() => {
    const i = nextImageIndex(1);
    if (i >= 0) { IV.dir = 1; load(i); }
  }, S.img.interval * 1000);
}

// ------------------------------------------------------------ filmstrip
let stripKey = '';
const thumbObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    thumbObserver.unobserve(en.target);
    loadThumb(en.target);
  }
}, { root: $('#filmstrip'), rootMargin: '0px 600px' });

async function loadThumb(btn) {
  const p = btn.dataset.path;
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  const t = await api.thumb(p);
  img.onerror = () => { if (t && img.src !== api.mediaUrl(p)) img.src = api.mediaUrl(p); };
  img.src = api.mediaUrl(t || p);
  btn.appendChild(img);
}
function renderFilmstrip() {
  const strip = $('#filmstrip');
  const idx = imageIndices();
  const show = IV.active && S.img.strip && idx.length > 1;
  const wasShown = stripShown();
  stage.classList.toggle('strip-on', show);
  if (wasShown !== show && IV.fit && IV.nat.w) fitView(false);
  if (!show) return;
  const key = idx.map((i) => S.playlist[i].path).join('|');
  if (key !== stripKey) {
    stripKey = key;
    strip.replaceChildren();
    for (const i of idx) {
      const b = document.createElement('button');
      b.dataset.i = i;
      b.dataset.path = S.playlist[i].path;
      b.title = S.playlist[i].name;
      strip.appendChild(b);
      thumbObserver.observe(b);
    }
  }
  strip.querySelectorAll('button').forEach((b) => b.classList.toggle('current', +b.dataset.i === S.index));
  const cur = strip.querySelector('.current');
  if (cur) cur.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}
$('#filmstrip').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  const i = +b.dataset.i;
  IV.dir = i >= S.index ? 1 : -1;
  load(i);
});
$('#filmstrip').addEventListener('wheel', (e) => {
  e.stopPropagation();
  e.preventDefault();
  $('#filmstrip').scrollLeft += e.deltaY + e.deltaX;
}, { passive: false });

// ------------------------------------------------------------ info panel
async function updateImageInfo() {
  const box = $('#img-info');
  box.classList.toggle('hidden', !S.img.info);
  if (!S.img.info || !current?.image) return;
  const item = current.item;
  const st = await api.fileStat(item.path);
  const size = st ? (st.size > 1048576 ? (st.size / 1048576).toFixed(2) + ' MB' : Math.round(st.size / 1024) + ' KB') : '?';
  const mp = ((IV.nat.w * IV.nat.h) / 1e6).toFixed(1);
  const rows = [
    ['Size', `${IV.nat.w} × ${IV.nat.h} (${mp} MP)`],
    ['File', size],
    ['Format', extOf(item.path).toUpperCase() + (IV.converted ? ' (converted)' : '')],
    ['Modified', st ? new Date(st.mtime).toLocaleString() : '?'],
    ['Zoom', `<span id="info-zoom"></span>`],
    ['Folder', escapeHtml(item.path.replace(/[\\/][^\\/]*$/, ''))],
  ];
  box.innerHTML = `<b>${escapeHtml(baseName(item.path))}</b><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  updateZoomInfo();
}
function updateZoomInfo() {
  const z = $('#info-zoom');
  if (z) z.textContent = `${Math.round(IV.scale * 100)}%${IV.rot % 360 ? ` · ${((IV.rot % 360) + 360) % 360}°` : ''}${IV.flip < 0 ? ' · flipped' : ''}`;
}
function toggleInfo() {
  S.img.info = !S.img.info;
  applyImageSettings();
  updateImageInfo();
  save();
}
function toggleStrip() {
  S.img.strip = !S.img.strip;
  $('#s-strip').checked = S.img.strip;
  applyImageSettings();
  save();
}

// ------------------------------------------------------------ toolbar + keys
$('#img-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-img]');
  if (!b) return;
  ({
    'zoom-in': () => zoomBy(1.25),
    'zoom-out': () => zoomBy(1 / 1.25),
    'toggle-zoom': () => toggleZoom(),
    fit: () => fitView(true),
    'rot-l': () => rotate(-90),
    'rot-r': () => rotate(90),
    flip,
    slideshow: () => toggleSlideshow(),
    info: toggleInfo,
    filmstrip: toggleStrip,
  })[b.dataset.img]?.();
});

// returns true when the key was handled by the image viewer
function imageKey(e) {
  const k = e.key;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (k === 'ArrowRight' || k === 'PageDown') { IV.dir = 1; stepImage(1); }
  else if (k === 'ArrowLeft' || k === 'PageUp') { IV.dir = -1; stepImage(-1); }
  else if (k === 'Home') { const idx = imageIndices(); if (idx.length) { IV.dir = -1; load(idx[0]); } }
  else if (k === 'End') { const idx = imageIndices(); if (idx.length) { IV.dir = 1; load(idx[idx.length - 1]); } }
  else if (k === '+' || k === '=') zoomBy(1.25);
  else if (k === '-' || k === '_') zoomBy(1 / 1.25);
  else if (k === '0') fitView(true);
  else if (k === '1') zoomTo(1);
  else if (k === 'r') rotate(90);
  else if (k === 'R') rotate(-90);
  else if (k === 'h') flip();
  else if (k === 'i') toggleInfo();
  else if (k === 't') toggleStrip();
  else if (k === ' ' || k === 'k') toggleSlideshow();
  else return false;
  return true;
}
