// JS Player — renderer
const api = window.prism;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
document.documentElement.dataset.platform = api.platform;
hydrateIcons();

// ---------------------------------------------------------------- settings
const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [7, 6, 4.5, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2.5, 4, 5.5, 6.5],
  Vocal: [-2, -2, -1, 1, 3.5, 4, 3, 1.5, 0, -1],
  Rock: [5, 4, 2.5, 0, -1.5, -1, 1, 3, 4, 4.5],
  Pop: [-1, 1, 3, 4, 3, 0, -1, -1, 0, 1],
  Electronic: [6, 5, 1.5, 0, -2, 1.5, 0.5, 1.5, 4.5, 5],
  Jazz: [3.5, 2.5, 1, 2, -1.5, -1.5, 0, 1.5, 3, 3.5],
  Classical: [4, 3, 2.5, 1.5, -1, -1, 0, 2, 3, 3.5],
  Acoustic: [4, 4, 3, 1, 1.5, 1.5, 3, 3.5, 3, 2],
  Loudness: [6, 4, 0, 0, -2, 0, -1, -4, 5, 1],
  'Podcast / speech': [-4, -3, -1, 1.5, 4, 4.5, 3.5, 1.5, -1, -3],
};
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];

const DEFAULTS = {
  volume: 1, muted: false, speed: 1,
  themeName: 'Midnight', theme: null, customThemes: [],
  viz: { mode: 'bars', bars: 96, sensitivity: 1, smoothing: 0.72, glow: 14, peaks: true, pulse: true, art: true, onVideo: false, colorMode: 'theme', custom: ['#ff3cac', '#784ba0', '#2b86c5'] },
  eq: { on: false, preset: 'Flat', gains: [...EQ_PRESETS.Flat], preamp: 0, pan: 0, bass: 0 },
  playlist: [], index: -1, shuffle: false, repeat: 'off',
  resume: true, autoplay: true, autoconvert: true, autosubs: true, seekStep: 5, onTop: false, autohide: true,
  sub: { size: 100, color: '#ffffff', bg: '#000000', bga: 0.55 },
  positions: {}, sidebar: true, tab: 'playlist',
  img: { interval: 5, transition: 'fade', bg: 'theme', upscale: false, strip: true, info: false },
  mode: 'player',
  feeds: { autoNext: false, askedAuto: false, last: null, quality: 'auto' },
};

let S = structuredClone(DEFAULTS);
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveSettings(S), 300);
}

// ---------------------------------------------------------------- elements
const video = $('#media');
const stage = $('#stage');
const vizCanvas = $('#viz');
const viz = new Visualizer(vizCanvas, document.documentElement);
viz.coverEl = $('#cover');

const fmt = (t) => {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const baseName = (p) => p.split(/[\\/]/).pop();
const stripExt = (n) => n.replace(/\.[^.]+$/, '');
const extOf = (p) => (p.split('.').pop() || '').toLowerCase();

let osdTimer;
function osd(text, ms = 1300) {
  const el = $('#osd');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function updateRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty('--p', ((+el.value - min) / (max - min)) * 100 + '%');
}
document.addEventListener('input', (e) => { if (e.target.type === 'range') updateRange(e.target); });

// ---------------------------------------------------------------- audio graph
let actx = null;
const N = {};
function initAudio() {
  if (actx) return;
  actx = new AudioContext({ latencyHint: 'playback' });
  N.src = actx.createMediaElementSource(video);
  N.pre = actx.createGain();
  N.bass = actx.createBiquadFilter();
  N.bass.type = 'lowshelf';
  N.bass.frequency.value = 100;
  N.eq = EQ_FREQS.map((f, i) => {
    const b = actx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    b.frequency.value = f;
    b.Q.value = 1.1;
    return b;
  });
  N.pan = actx.createStereoPanner();
  N.analyser = actx.createAnalyser();
  N.analyser.fftSize = 4096;
  N.vol = actx.createGain();
  const chain = [N.src, N.pre, N.bass, ...N.eq, N.pan, N.analyser, N.vol, actx.destination];
  for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  viz.attach(N.analyser);
  applyAudio();
}

function applyAudio() {
  video.playbackRate = S.speed;
  video.preservesPitch = true;
  if (!actx) return;
  const t = actx.currentTime;
  const on = S.eq.on;
  N.pre.gain.setTargetAtTime(on ? Math.pow(10, S.eq.preamp / 20) : 1, t, 0.02);
  N.bass.gain.setTargetAtTime(on ? S.eq.bass : 0, t, 0.02);
  N.eq.forEach((b, i) => b.gain.setTargetAtTime(on ? S.eq.gains[i] : 0, t, 0.02));
  N.pan.pan.setTargetAtTime(S.eq.pan, t, 0.02);
  N.vol.gain.setTargetAtTime(S.muted ? 0 : S.volume, t, 0.02);
  N.analyser.smoothingTimeConstant = S.viz.smoothing;
}

// ---------------------------------------------------------------- playback
let current = null; // { item, converted, info }
let loadToken = 0;
let pendingStart = 0;
let shouldPlay = false;
let converting = false;
let ab = { a: null, b: null };

async function addFiles(paths, playFirst = true) {
  if (!paths || !paths.length) return;
  const subs = paths.filter((p) => ['srt', 'vtt'].includes(extOf(p)));
  if (subs.length && current) loadSubtitle(subs[0]);
  let media = paths.filter((p) => !['srt', 'vtt'].includes(extOf(p)));
  if (!media.length) return;
  if (FD.mode === 'feeds' && playFirst) setMode('player');
  let start = media[0];
  // opening a single photo brings in the rest of its folder, like a normal image viewer
  if (media.length === 1 && isImagePath(media[0])) {
    const sib = await api.imageSiblings(media[0]);
    if (sib.length > 1 && sib.some((p) => p.toLowerCase() === start.toLowerCase())) {
      media = sib;
      start = sib.find((p) => p.toLowerCase() === start.toLowerCase());
    }
  }
  let firstIdx = -1;
  for (const p of media) {
    let idx = S.playlist.findIndex((it) => it.path === p);
    if (idx === -1) {
      S.playlist.push({ path: p, name: stripExt(baseName(p)) });
      idx = S.playlist.length - 1;
    }
    if (p === start) firstIdx = idx;
  }
  renderPlaylist();
  queueProbe();
  if (playFirst) load(firstIdx, { autoplay: true });
  save();
}

function load(i, opts = {}) {
  if (i < 0 || i >= S.playlist.length) return;
  rememberPosition();
  const item = S.playlist[i];
  const prevIndex = S.index;
  S.index = i;

  if (isImagePath(item.path)) {
    ++loadToken;
    converting = false;
    hideBusy();
    current = { item, image: true, converted: false, info: null };
    video.pause();
    if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
    [...video.querySelectorAll('track')].forEach((t) => t.remove());
    $('#empty').classList.add('hidden');
    stage.classList.remove('has-video');
    $('#audio-info').classList.add('hidden');
    setMeta({ title: item.name, artist: '' }, null);
    if (!IV.slideshow) IV.dir = i >= prevIndex ? 1 : -1;
    loadImage(item);
    syncPlayUI();
    renderPlaylist();
    scrollCurrentIntoView();
    save();
    return;
  }
  exitImageMode();

  current = { item, converted: false, info: null };
  const token = ++loadToken;
  converting = false;
  ab = { a: null, b: null };
  updateAB();
  hideBusy();
  initAudio();
  if (actx.state === 'suspended') actx.resume();

  $('#empty').classList.add('hidden');
  stage.classList.remove('has-video');
  $('#audio-info').classList.add('hidden');
  [...video.querySelectorAll('track')].forEach((t) => t.remove());
  pendingStart = S.resume ? S.positions[item.path] || 0 : 0;
  shouldPlay = opts.autoplay ?? S.autoplay;
  video.src = api.mediaUrl(item.path);
  video.load();

  setMeta({ title: item.title || item.name, artist: item.artist || '' }, null);
  api.probe(item.path).then((info) => {
    if (token !== loadToken) return;
    current.info = info;
    Object.assign(item, metaFromInfo(info, item));
    setMeta(item, info.cover);
    renderPlaylist();
    checkUndecodableVideo();
  });
  if (S.autosubs) api.findSidecarSubs(item.path).then((p) => { if (p && token === loadToken) loadSubtitle(p, true); });
  renderPlaylist();
  scrollCurrentIntoView();
  save();
}

function metaFromInfo(info, item) {
  const m = info.metadata || {};
  return {
    title: m.title || item.name,
    artist: [m.artist || m.album_artist, m.album].filter(Boolean).join(' — '),
    duration: info.duration || item.duration,
    kind: info.hasVideo ? 'video' : 'audio',
  };
}

function setMeta(item, cover) {
  $('#meta-title').textContent = item.title || item.name || '';
  $('#meta-artist').textContent = item.artist || '';
  $('#now-title').textContent = (item.artist ? item.artist.split(' — ')[0] + ' — ' : '') + (item.title || item.name || '');
  api.windowCmd('title', `${item.title || item.name} — JS Player`);
  const img = $('#cover');
  img.src = cover ? api.mediaUrl(cover) : placeholderCover();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: item.title || item.name, artist: item.artist || '' });
  }
}

function placeholderCover() {
  const cs = getComputedStyle(document.documentElement);
  const a = cs.getPropertyValue('--accent').trim(), b = cs.getPropertyValue('--accent2').trim();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><g fill="none" stroke="rgba(255,255,255,.85)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" transform="translate(52 52) scale(4)"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></g></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function checkUndecodableVideo() {
  // audio plays but the video track can't be decoded (e.g. some HEVC/MPEG-2 files)
  if (!current || current.converted || converting || !current.info) return;
  if (current.info.hasVideo && video.readyState >= 1 && video.videoWidth === 0 && S.autoconvert) {
    convert('This video codec needs converting');
  }
}

async function convert(reason) {
  if (!current || converting) return;
  const token = loadToken;
  const item = current.item;
  const resumeAt = video.currentTime > 1 ? video.currentTime : pendingStart;
  converting = true;
  video.pause();
  video.removeAttribute('src');
  video.load();
  showBusy(`${reason || 'Converting'}…`);
  const r = await api.transcode(item.path);
  api.windowCmd('progress', -1);
  if (token !== loadToken) return;
  converting = false;
  hideBusy();
  if (r.error) {
    showError(r.error);
    return;
  }
  current.converted = true;
  pendingStart = resumeAt;
  shouldPlay = true;
  video.src = api.mediaUrl(r.path);
  video.load();
  if (!r.cached) osd('Converted — saved to cache for next time', 2200);
}

function showBusy(text) {
  $('#busy-text').textContent = text;
  $('#busy-fill').style.width = '0%';
  $('#busy').classList.remove('hidden');
}
function hideBusy() { $('#busy').classList.add('hidden'); }
api.onTranscodeProgress((v) => {
  $('#busy-fill').style.width = (v * 100).toFixed(1) + '%';
  $('#busy-text').textContent = `Converting… ${Math.round(v * 100)}%`;
  api.windowCmd('progress', v);
});
$('#busy-cancel').onclick = () => { api.cancelTranscode(); };

function showError(msg) {
  osd('⚠ ' + msg, 5000);
  console.warn(msg);
}

function togglePlay() {
  if (!current) {
    if (S.playlist.length) return load(Math.max(0, S.index), { autoplay: true });
    return openFiles();
  }
  if (current.image) return toggleSlideshow();
  if (actx && actx.state === 'suspended') actx.resume();
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
function stop() {
  if (current?.image) return toggleSlideshow(false, true);
  video.pause();
  video.currentTime = 0;
}
function seekBy(d) {
  if (!isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 0.1, video.currentTime + d));
  osd(`${d > 0 ? '+' : '−'}${Math.abs(d)}s  ·  ${fmt(video.currentTime)}`);
}
function setVolume(v, show = true) {
  S.volume = Math.max(0, Math.min(2, Math.round(v * 100) / 100));
  S.muted = false;
  applyAudio();
  syncVolumeUI();
  if (show) osd(`Volume ${Math.round(S.volume * 100)}%`);
  save();
}
function toggleMute() {
  S.muted = !S.muted;
  applyAudio();
  syncVolumeUI();
  osd(S.muted ? 'Muted' : `Volume ${Math.round(S.volume * 100)}%`);
  save();
}
function setSpeed(v) {
  S.speed = Math.max(0.25, Math.min(4, Math.round(v * 100) / 100));
  applyAudio();
  $('#b-speed').textContent = S.speed.toFixed(2) + '×';
  $('#b-speed').classList.toggle('on', S.speed !== 1);
  osd(`Speed ${S.speed.toFixed(2)}×`);
  save();
}

function nextIndex(dir) {
  const n = S.playlist.length;
  if (!n) return -1;
  if (S.shuffle && n > 1) {
    let r;
    do r = Math.floor(Math.random() * n); while (r === S.index);
    return r;
  }
  const i = S.index + dir;
  if (i >= n) return S.repeat === 'all' ? 0 : -1;
  if (i < 0) return S.repeat === 'all' ? n - 1 : 0;
  return i;
}
function next() { const i = nextIndex(1); if (i >= 0) load(i, { autoplay: true }); }
function prev() {
  if (video.currentTime > 4) { video.currentTime = 0; return; }
  const i = nextIndex(-1);
  if (i >= 0) load(i, { autoplay: true });
}

function rememberPosition() {
  if (!current || !S.resume) return;
  const p = current.item.path, t = video.currentTime, d = video.duration;
  if (isFinite(d) && d > 60 && t > 10 && t < d - 15) S.positions[p] = Math.floor(t);
  else delete S.positions[p];
  const keys = Object.keys(S.positions);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete S.positions[k];
}

// media element events
video.addEventListener('loadedmetadata', () => {
  const hasVideo = video.videoWidth > 0;
  stage.classList.toggle('has-video', hasVideo);
  $('#audio-info').classList.toggle('hidden', hasVideo);
  if (pendingStart > 3 && isFinite(video.duration) && pendingStart < video.duration - 5) {
    video.currentTime = pendingStart;
    osd(`Resumed at ${fmt(pendingStart)}`, 1800);
  }
  pendingStart = 0;
  if (current && !current.item.duration && isFinite(video.duration)) { current.item.duration = video.duration; renderPlaylist(); }
  if (shouldPlay) video.play().catch(() => {});
  shouldPlay = false;
  checkUndecodableVideo();
  updateTime();
});
video.addEventListener('error', () => {
  if (converting || !current || !video.getAttribute('src')) return;
  if (!current.converted && S.autoconvert) convert('Format not supported natively — converting');
  else showError(`Can't play “${current.item.name}”`);
});
video.addEventListener('play', syncPlayUI);
video.addEventListener('pause', syncPlayUI);
video.addEventListener('ended', () => {
  if (S.repeat === 'one') { video.currentTime = 0; video.play(); return; }
  if (current) delete S.positions[current.item.path];
  const i = nextIndex(1);
  if (i >= 0) load(i, { autoplay: true });
});
video.addEventListener('timeupdate', () => {
  updateTime();
  if (ab.a != null && ab.b != null && video.currentTime >= ab.b) video.currentTime = ab.a;
});
video.addEventListener('progress', updateBuffered);
let posSaveTick = 0;
setInterval(() => { if (current && !video.paused && ++posSaveTick % 5 === 0) { rememberPosition(); save(); } }, 1000);
window.addEventListener('beforeunload', () => { rememberPosition(); api.saveSettings(S); });

function syncPlayUI() {
  const imageMode = typeof IV !== 'undefined' && IV.active;
  setIcon($('#b-play'), (imageMode ? !IV.slideshow : video.paused) ? 'play' : 'pause');
  $('#b-play').title = imageMode ? 'Slideshow (Space)' : 'Play / pause (Space)';
  viz.visible = true;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = video.paused ? 'paused' : 'playing';
  bumpIdle();
}

// ---------------------------------------------------------------- seek bar
const seek = $('#seek');
let dragging = false;
function updateTime() {
  const d = video.duration, t = video.currentTime;
  $('#t-cur').textContent = fmt(t);
  $('#t-dur').textContent = fmt(d);
  if (!dragging) {
    const p = isFinite(d) && d ? (t / d) * 100 : 0;
    $('#seek-fill').style.width = p + '%';
    $('#seek-thumb').style.left = p + '%';
  }
}
function updateBuffered() {
  const d = video.duration;
  if (!isFinite(d) || !video.buffered.length) return;
  $('#seek-buf').style.width = (video.buffered.end(video.buffered.length - 1) / d) * 100 + '%';
}
const fracAt = (x) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)); };
seek.addEventListener('pointerdown', (e) => {
  if (!isFinite(video.duration)) return;
  dragging = true;
  seek.setPointerCapture(e.pointerId);
  const f = fracAt(e.clientX);
  $('#seek-fill').style.width = $('#seek-thumb').style.left = f * 100 + '%';
});
seek.addEventListener('pointermove', (e) => {
  const f = fracAt(e.clientX);
  const tip = $('#seek-tip');
  tip.style.left = f * 100 + '%';
  tip.textContent = fmt(f * (video.duration || 0));
  if (dragging) $('#seek-fill').style.width = $('#seek-thumb').style.left = f * 100 + '%';
});
seek.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  dragging = false;
  video.currentTime = fracAt(e.clientX) * video.duration;
});

function toggleAB() {
  if (!current) return;
  if (ab.a == null) { ab.a = video.currentTime; osd(`Loop start A = ${fmt(ab.a)}`); }
  else if (ab.b == null) {
    if (video.currentTime <= ab.a) { ab.a = video.currentTime; osd('Loop start moved'); }
    else { ab.b = video.currentTime; osd(`Looping ${fmt(ab.a)} → ${fmt(ab.b)}`); }
  } else { ab = { a: null, b: null }; osd('Loop off'); }
  updateAB();
}
function updateAB() {
  const el = $('#seek-ab'), d = video.duration;
  $('#b-ab').classList.toggle('on', ab.a != null);
  if (ab.a == null || !isFinite(d)) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.left = (ab.a / d) * 100 + '%';
  el.style.width = (((ab.b ?? video.currentTime) - ab.a) / d) * 100 + '%';
}

// ---------------------------------------------------------------- subtitles
async function loadSubtitle(p, quiet) {
  const text = await api.readText(p);
  if (text == null) return showError('Could not read subtitle file');
  const vtt = /^WEBVTT/.test(text.trimStart())
    ? text
    : 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/^﻿/, '').replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').replace(/<\/?font[^>]*>/g, '');
  [...video.querySelectorAll('track')].forEach((t) => t.remove());
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = baseName(p);
  track.default = true;
  track.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  video.appendChild(track);
  track.addEventListener('load', () => { track.track.mode = 'showing'; });
  track.track.mode = 'showing';
  if (!quiet) osd(`Subtitles: ${baseName(p)}`);
  else osd('Subtitles loaded');
}
function applySubStyle() {
  const r = document.documentElement.style;
  const [cr, cg, cb] = hexToRgb(S.sub.bg);
  r.setProperty('--sub-size', S.sub.size + '%');
  r.setProperty('--sub-color', S.sub.color);
  r.setProperty('--sub-bg', `rgba(${cr},${cg},${cb},${S.sub.bga})`);
}

// ---------------------------------------------------------------- playlist UI
const plEl = $('#playlist');
let dragFrom = -1;
function renderPlaylist() {
  const q = $('#pl-search').value.trim().toLowerCase();
  $('#pl-count').textContent = S.playlist.length ? `· ${S.playlist.length}` : '';
  if (!S.playlist.length) {
    plEl.innerHTML = '<li class="empty-note">Nothing here yet. Open or drop files to start.</li>';
    return;
  }
  const frag = document.createDocumentFragment();
  S.playlist.forEach((it, i) => {
    const hay = `${it.title || ''} ${it.name} ${it.artist || ''}`.toLowerCase();
    if (q && !hay.includes(q)) return;
    const li = document.createElement('li');
    li.dataset.i = i;
    li.draggable = !q;
    li.className = i === S.index ? 'current' : '';
    li.title = it.path;
    li.innerHTML = `<span class="num">${i === S.index && !video.paused ? '▶' : i + 1}</span>
      <span class="name"></span>
      <span class="dur">${it.duration ? fmt(it.duration) : it.dims || ''}</span>
      <button class="icon-btn rm" title="Remove">${icon('x')}</button>`;
    const name = li.querySelector('.name');
    name.textContent = it.title || it.name;
    const kind = isImagePath(it.path) ? 'image' : it.kind === 'video' ? 'film' : null;
    if (kind) name.insertAdjacentHTML('afterbegin', `<span class="kind">${icon(kind)}</span>`);
    if (it.artist) { const s = document.createElement('span'); s.className = 'sub'; s.textContent = it.artist; name.appendChild(s); }
    frag.appendChild(li);
  });
  plEl.replaceChildren(frag);
}
function scrollCurrentIntoView() {
  const li = plEl.querySelector('li.current');
  if (li) li.scrollIntoView({ block: 'nearest' });
}
plEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const i = +li.dataset.i;
  if (e.target.closest('.rm')) return removeItem(i);
  load(i, { autoplay: true });
});
plEl.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) api.showInFolder(S.playlist[+li.dataset.i].path);
});
plEl.addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[data-i]');
  dragFrom = li ? +li.dataset.i : -1;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/x-prism', String(dragFrom));
});
plEl.addEventListener('dragover', (e) => {
  if (dragFrom < 0) return;
  e.preventDefault();
  e.stopPropagation();
  $$('.drag-over', plEl).forEach((x) => x.classList.remove('drag-over'));
  const li = e.target.closest('li[data-i]');
  if (li) li.classList.add('drag-over');
});
plEl.addEventListener('drop', (e) => {
  if (dragFrom < 0) return;
  e.preventDefault();
  e.stopPropagation();
  const li = e.target.closest('li[data-i]');
  const to = li ? +li.dataset.i : S.playlist.length - 1;
  const cur = S.playlist[S.index];
  const [moved] = S.playlist.splice(dragFrom, 1);
  S.playlist.splice(to, 0, moved);
  S.index = S.playlist.indexOf(cur);
  dragFrom = -1;
  renderPlaylist();
  save();
});
plEl.addEventListener('dragend', () => { dragFrom = -1; $$('.drag-over', plEl).forEach((x) => x.classList.remove('drag-over')); });

function removeItem(i) {
  const wasCurrent = i === S.index;
  S.playlist.splice(i, 1);
  if (i < S.index) S.index--;
  if (wasCurrent) {
    exitImageMode();
    video.pause();
    video.removeAttribute('src');
    video.load();
    current = null;
    S.index = -1;
    showEmptyIfNeeded();
  }
  renderPlaylist();
  save();
}
function showEmptyIfNeeded() {
  const empty = !current;
  $('#empty').classList.toggle('hidden', !empty);
  if (empty) { stage.classList.remove('has-video'); $('#audio-info').classList.add('hidden'); $('#now-title').textContent = ''; }
}
$('#pl-search').addEventListener('input', renderPlaylist);
$('#pl-clear').onclick = () => {
  if (!S.playlist.length) return;
  exitImageMode();
  video.pause();
  video.removeAttribute('src');
  video.load();
  S.playlist = []; S.index = -1; current = null;
  renderPlaylist(); showEmptyIfNeeded(); save();
};
$('#pl-sort').onclick = () => {
  const cur = S.playlist[S.index];
  S.playlist.sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name, undefined, { numeric: true, sensitivity: 'base' }));
  S.index = S.playlist.indexOf(cur);
  renderPlaylist(); save();
};
$('#pl-shuffle').onclick = () => { S.shuffle = !S.shuffle; syncModeButtons(); osd(S.shuffle ? 'Shuffle on' : 'Shuffle off'); save(); };
$('#pl-repeat').onclick = () => {
  S.repeat = { off: 'all', all: 'one', one: 'off' }[S.repeat];
  syncModeButtons();
  osd({ off: 'Repeat off', all: 'Repeat playlist', one: 'Repeat this file' }[S.repeat]);
  save();
};
function syncModeButtons() {
  $('#pl-shuffle').classList.toggle('on', S.shuffle);
  $('#pl-repeat').classList.toggle('on', S.repeat !== 'off');
  setIcon($('#pl-repeat'), S.repeat === 'one' ? 'repeat1' : 'repeat');
}

// background probing for durations/titles
let probing = false;
async function queueProbe() {
  if (probing) return;
  probing = true;
  for (let guard = 0; guard < 2000; guard++) {
    const it = S.playlist.find((x) => x.duration == null && !x._probed && !isImagePath(x.path));
    if (!it) break;
    it._probed = true;
    try {
      const info = await api.probe(it.path);
      if (info.ok) Object.assign(it, metaFromInfo(info, it));
      else it.duration = 0;
    } catch { it.duration = 0; }
    renderPlaylist();
  }
  probing = false;
  save();
}

// ---------------------------------------------------------------- open / drop
async function openFiles() { addFiles(await api.openFiles(), true); }
async function openFolder() { addFiles(await api.openFolder(), true); }
async function openSubs() {
  if (!current) return osd('Play something first');
  const p = await api.openSubtitle();
  if (p) loadSubtitle(p);
}
const COMMANDS = {
  open: openFiles,
  folder: openFolder,
  subs: openSubs,
  'toggle-sidebar': () => toggleSidebar(),
};
document.addEventListener('click', (e) => {
  // keep keyboard shortcuts (Space) from re-clicking the last button
  const btn = e.target.closest('button');
  if (btn) setTimeout(() => btn.blur(), 0);
  const b = e.target.closest('[data-cmd]');
  if (b && COMMANDS[b.dataset.cmd]) COMMANDS[b.dataset.cmd]();
});

let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { dragDepth++; $('#drop-hint').classList.remove('hidden'); } });
window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop-hint').classList.add('hidden'); } });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').classList.add('hidden');
  const raw = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  const subs = raw.filter((p) => ['srt', 'vtt'].includes(extOf(p)));
  const media = await api.expandPaths(raw.filter((p) => !subs.includes(p)));
  if (subs.length && !media.length) return current ? loadSubtitle(subs[0]) : osd('Play something first');
  addFiles(media, true);
});

// ---------------------------------------------------------------- controls wiring
$('#b-play').onclick = togglePlay;
$('#b-stop').onclick = stop;
$('#b-prev').onclick = prev;
$('#b-next').onclick = next;
$('#b-back').onclick = () => seekBy(-S.seekStep);
$('#b-fwd').onclick = () => seekBy(S.seekStep);
$('#b-mute').onclick = toggleMute;
$('#volume').addEventListener('input', (e) => setVolume(+e.target.value, false));
$('#b-speed').onclick = () => { const i = SPEEDS.findIndex((s) => s > S.speed + 0.001); setSpeed(SPEEDS[i === -1 ? 0 : i]); };
$('#b-speed').oncontextmenu = () => setSpeed(1);
$('#b-ab').onclick = toggleAB;
$('#b-viz').onclick = () => cycleViz(1);
$('#b-shot').onclick = screenshot;
$('#b-pip').onclick = async () => {
  if (!stage.classList.contains('has-video')) return osd('Picture-in-picture needs a video');
  try { document.pictureInPictureElement ? await document.exitPictureInPicture() : await video.requestPictureInPicture(); } catch (e) { showError(e.message); }
};
$('#b-full').onclick = () => toggleFullscreen();

function syncVolumeUI() {
  const v = $('#volume');
  v.value = S.muted ? 0 : S.volume;
  updateRange(v);
  $('#vol-val').textContent = S.muted ? 'Muted' : Math.round(S.volume * 100) + '%';
  setIcon($('#b-mute'), S.muted || S.volume === 0 ? 'mute' : S.volume < 0.5 ? 'volLow' : 'vol');
}

stage.addEventListener('click', (e) => {
  if (e.target.closest('button, .busy, .img-info') || !current || current.image) return;
  clickTimer = setTimeout(togglePlay, 220);
});
let clickTimer;
stage.addEventListener('dblclick', (e) => {
  if (e.target.closest('button, .busy, .img-info, .filmstrip')) return;
  clearTimeout(clickTimer);
  if (current?.image) toggleZoom(e);
  else toggleFullscreen();
});
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (current?.image) {
    if (e.ctrlKey || !e.shiftKey) zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e);
    else { IV.dir = e.deltaY > 0 ? 1 : -1; stepImage(IV.dir); } // Shift+wheel flips through images
    return;
  }
  setVolume(S.volume + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });

async function screenshot() {
  if (!current) return;
  const c = document.createElement('canvas');
  if (stage.classList.contains('has-video')) {
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
  } else {
    c.width = vizCanvas.width; c.height = vizCanvas.height;
    const g = c.getContext('2d');
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg');
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(vizCanvas, 0, 0);
  }
  const file = await api.saveScreenshot(c.toDataURL('image/png'), `${current.item.name}-${fmt(video.currentTime).replace(/:/g, '.')}`);
  osd('Screenshot saved to Pictures\\JS Player', 2200);
  console.log('screenshot', file);
}

// fullscreen + idle
let fs = false;
function toggleFullscreen(force) {
  fs = force ?? !fs;
  document.body.classList.toggle('fs', fs);
  api.windowCmd('fullscreen', fs);
  setIcon($('#b-full'), fs ? 'exitFull' : 'full');
  $('#controls').classList.toggle('autohide', fs && S.autohide);
  bumpIdle();
}
let idleTimer;
function bumpIdle() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if ((!video.paused || current?.image) && fs) document.body.classList.add('idle'); }, 2500);
}
document.addEventListener('mousemove', bumpIdle);

function toggleSidebar(force) {
  S.sidebar = force ?? !S.sidebar;
  document.body.classList.toggle('sidebar-hidden', !S.sidebar);
  save();
}

// tabs
$$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
function selectTab(name) {
  S.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (!S.sidebar) toggleSidebar(true);
  save();
}

// ---------------------------------------------------------------- keyboard
const SHORTCUTS = [
  ['Space / K', 'Play / pause'], ['← / →', `Seek (Shift = 1s, Ctrl = 60s)`], ['↑ / ↓', 'Volume'], ['M', 'Mute'],
  ['F / dbl-click', 'Fullscreen'], ['Esc', 'Exit fullscreen'], ['N / P', 'Next / previous'], ['[ / ]', 'Slower / faster'],
  ['Backspace', 'Normal speed'], [', / .', 'Frame step (paused)'], ['L', 'A-B loop'], ['V', 'Next visualizer'],
  ['S', 'Screenshot'], ['Tab', 'Toggle side panel'], ['Ctrl+O', 'Open files'], ['Ctrl+Shift+O', 'Open folder'], ['0–9', 'Jump to 0–90%'],
  ['Images:', ''], ['← / →', 'Previous / next image'], ['Wheel / + / −', 'Zoom (Shift+wheel: next image)'], ['Drag', 'Pan'],
  ['0 / 1 / dbl-click', 'Fit / 100% / toggle'], ['R / Shift+R', 'Rotate right / left'], ['H', 'Flip'],
  ['Space', 'Slideshow'], ['I', 'Image info'], ['T', 'Filmstrip'], ['Home / End', 'First / last image'],
];
$('#keys').innerHTML = SHORTCUTS.map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if ((tag === 'INPUT' && !['range', 'checkbox'].includes(e.target.type)) || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const k = e.key;
  if (FD.mode === 'feeds') return; // keys belong to the feed
  if (current?.image && imageKey(e)) { e.preventDefault(); bumpIdle(); return; }
  const step = e.shiftKey ? 1 : e.ctrlKey ? 60 : S.seekStep;
  let handled = true;
  if (e.ctrlKey && k.toLowerCase() === 'o') e.shiftKey ? openFolder() : openFiles();
  else if (k === ' ' || k === 'k') togglePlay();
  else if (k === 'ArrowRight') seekBy(step);
  else if (k === 'ArrowLeft') seekBy(-step);
  else if (k === 'ArrowUp') setVolume(S.volume + 0.05);
  else if (k === 'ArrowDown') setVolume(S.volume - 0.05);
  else if (k === 'm') toggleMute();
  else if (k === 'f' || k === 'Enter') toggleFullscreen();
  else if (k === 'Escape') { if (fs) toggleFullscreen(false); }
  else if (k === 'n') next();
  else if (k === 'p') prev();
  else if (k === ']') setSpeed(S.speed + 0.25);
  else if (k === '[') setSpeed(S.speed - 0.25);
  else if (k === 'Backspace') setSpeed(1);
  else if (k === '.' && video.paused) video.currentTime += 1 / 30;
  else if (k === ',' && video.paused) video.currentTime -= 1 / 30;
  else if (k === 'l') toggleAB();
  else if (k === 'v') cycleViz(e.shiftKey ? -1 : 1);
  else if (k === 's') screenshot();
  else if (k === 'Tab') toggleSidebar();
  else if (/^[0-9]$/.test(k) && isFinite(video.duration)) video.currentTime = video.duration * (+k / 10);
  else handled = false;
  if (handled) { e.preventDefault(); bumpIdle(); }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => video.play());
  navigator.mediaSession.setActionHandler('pause', () => video.pause());
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}

// ---------------------------------------------------------------- equalizer UI
function buildEq() {
  const sel = $('#eq-preset');
  sel.innerHTML = Object.keys(EQ_PRESETS).map((n) => `<option>${n}</option>`).join('') + '<option value="Custom">Custom</option>';
  $('#eq-bands').innerHTML = EQ_FREQS.map((f, i) => `
    <div class="eq-band"><span class="eq-db" data-i="${i}"></span>
      <input type="range" min="-12" max="12" step="0.5" data-band="${i}">
      <span>${f >= 1000 ? f / 1000 + 'k' : f}</span></div>`).join('');
  $('#eq-bands').addEventListener('input', (e) => {
    const i = e.target.dataset.band;
    if (i == null) return;
    S.eq.gains[i] = +e.target.value;
    S.eq.preset = 'Custom';
    if (!S.eq.on) S.eq.on = true;
    syncEq();
  });
  sel.addEventListener('change', () => {
    if (EQ_PRESETS[sel.value]) S.eq.gains = [...EQ_PRESETS[sel.value]];
    S.eq.preset = sel.value;
    S.eq.on = true;
    syncEq();
  });
  $('#eq-on').addEventListener('change', (e) => { S.eq.on = e.target.checked; syncEq(); osd(S.eq.on ? 'Equalizer on' : 'Equalizer off'); });
  bindRange('#preamp', () => S.eq.preamp, (v) => { S.eq.preamp = v; S.eq.on = true; }, (v) => `${v > 0 ? '+' : ''}${v} dB`, '#preamp-val', syncEq);
  bindRange('#pan', () => S.eq.pan, (v) => { S.eq.pan = v; }, (v) => (v === 0 ? 'Center' : v < 0 ? `L ${Math.round(-v * 100)}%` : `R ${Math.round(v * 100)}%`), '#pan-val', syncEq);
  bindRange('#bass', () => S.eq.bass, (v) => { S.eq.bass = v; S.eq.on = true; }, (v) => `+${v} dB`, '#bass-val', syncEq);
  $('#eq-reset').onclick = () => { S.eq = structuredClone(DEFAULTS.eq); syncEq(); };
}
function syncEq() {
  $('#eq-on').checked = S.eq.on;
  $('#eq-preset').value = S.eq.preset;
  $('[data-panel="eq"]').classList.toggle('eq-disabled', !S.eq.on);
  $$('#eq-bands input').forEach((el, i) => { el.value = S.eq.gains[i]; updateRange(el); });
  $$('#eq-bands .eq-db').forEach((el, i) => { el.textContent = (S.eq.gains[i] > 0 ? '+' : '') + S.eq.gains[i]; });
  for (const id of ['#preamp', '#pan', '#bass']) { const el = $(id); el.value = { '#preamp': S.eq.preamp, '#pan': S.eq.pan, '#bass': S.eq.bass }[id]; updateRange(el); el.dispatchEvent(new Event('sync')); }
  applyAudio();
  save();
}

// generic range binding with live label
function bindRange(sel, get, set, label, labelSel, after) {
  const el = $(sel);
  const show = () => { if (labelSel) $(labelSel).textContent = label(+el.value); };
  el.value = get();
  updateRange(el);
  show();
  el.addEventListener('input', () => { set(+el.value); show(); after && after(); save(); });
  el.addEventListener('sync', show);
  return el;
}
function bindCheck(sel, get, set, after) {
  const el = $(sel);
  el.checked = get();
  el.addEventListener('change', () => { set(el.checked); after && after(); save(); });
}

// ---------------------------------------------------------------- visualizer UI
function buildVizUI() {
  $('#viz-modes').innerHTML = VIZ_MODES.map((m) => `<button class="chip" data-mode="${m.id}">${m.name}</button>`).join('');
  $('#viz-modes').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setVizMode(b.dataset.mode); });
  const color = $('#viz-color');
  color.value = S.viz.colorMode;
  color.addEventListener('change', () => { S.viz.colorMode = color.value; syncViz(); save(); });
  ['#viz-c1', '#viz-c2', '#viz-c3'].forEach((id, i) => {
    $(id).value = S.viz.custom[i];
    $(id).addEventListener('input', (e) => { S.viz.custom[i] = e.target.value; syncViz(); save(); });
  });
  bindRange('#viz-bars', () => S.viz.bars, (v) => { S.viz.bars = v; }, (v) => v, '#viz-bars-val', syncViz);
  bindRange('#viz-sens', () => S.viz.sensitivity, (v) => { S.viz.sensitivity = v; }, (v) => v.toFixed(2) + '×', '#viz-sens-val', syncViz);
  bindRange('#viz-smooth', () => S.viz.smoothing, (v) => { S.viz.smoothing = v; }, (v) => Math.round(v * 100) + '%', '#viz-smooth-val', () => { applyAudio(); });
  bindRange('#viz-glow', () => S.viz.glow, (v) => { S.viz.glow = v; }, (v) => v, '#viz-glow-val', syncViz);
  bindCheck('#viz-peaks', () => S.viz.peaks, (v) => { S.viz.peaks = v; }, syncViz);
  bindCheck('#viz-pulse', () => S.viz.pulse, (v) => { S.viz.pulse = v; }, syncViz);
  bindCheck('#viz-art', () => S.viz.art, (v) => { S.viz.art = v; }, syncViz);
  bindCheck('#viz-on-video', () => S.viz.onVideo, (v) => { S.viz.onVideo = v; }, syncViz);
}
function setVizMode(mode) {
  S.viz.mode = mode;
  syncViz();
  osd(`Visualizer: ${VIZ_MODES.find((m) => m.id === mode).name}`);
  save();
}
function cycleViz(dir) {
  const i = VIZ_MODES.findIndex((m) => m.id === S.viz.mode);
  setVizMode(VIZ_MODES[(i + dir + VIZ_MODES.length) % VIZ_MODES.length].id);
}
function syncViz() {
  viz.setOptions({ ...S.viz });
  $$('#viz-modes .chip').forEach((c) => c.classList.toggle('active', c.dataset.mode === S.viz.mode));
  $('[data-panel="visualizer"]').classList.toggle('custom-colors', S.viz.colorMode === 'custom');
  $('#b-viz').textContent = VIZ_MODES.find((m) => m.id === S.viz.mode).name;
  stage.classList.toggle('viz-radial', S.viz.mode === 'radial');
  stage.classList.toggle('no-art', !S.viz.art);
  stage.classList.toggle('viz-on-video', S.viz.onVideo);
  if (S.viz.mode === 'off') viz.ctx.clearRect(0, 0, viz.W, viz.H);
  if (!S.viz.pulse || S.viz.mode === 'off') document.documentElement.style.setProperty('--pulse', 0);
}

// ---------------------------------------------------------------- themes UI
function allThemes() { return [...PRESET_THEMES, ...S.customThemes]; }
function currentTheme() { return S.theme || allThemes().find((t) => t.name === S.themeName) || PRESET_THEMES[0]; }

function useTheme(t) {
  S.theme = { ...BASE_THEME, ...t };
  delete S.theme.preset;
  S.themeName = t.name;
  refreshTheme();
  save();
}
function refreshTheme() {
  const t = applyTheme(currentTheme());
  viz.refreshColors();
  $$('input[type=range]').forEach(updateRange);
  renderThemeList();
  syncThemeEditor(t);
  if (current && !current.info?.cover && !stage.classList.contains('has-video')) $('#cover').src = placeholderCover();
}
function renderThemeList() {
  const t = currentTheme();
  $('#theme-list').innerHTML = allThemes().map((th, i) => `
    <button class="theme-card ${th.name === S.themeName ? 'active' : ''}" data-i="${i}"
      style="background:${th.bg};color:${th.text};border-color:${th.name === S.themeName ? t.accent : th.border};border-radius:${Math.min(th.radius ?? 10, 16)}px;font-family:${(th.font || BASE_THEME.font).replace(/"/g, "'")}">
      <span>${escapeHtml(th.name)}</span>
      <span class="sw"><span style="background:${th.accent}"></span><span style="background:${th.accent2}"></span><span style="background:${th.surface}"></span><span style="background:${th.dim}"></span></span>
      ${th.preset ? '' : `<span class="del icon-btn" data-del="${escapeHtml(th.name)}" title="Delete">${icon('x')}</span>`}
    </button>`).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
$('#theme-list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    S.customThemes = S.customThemes.filter((t) => t.name !== del.dataset.del);
    renderThemeList(); save();
    return;
  }
  const card = e.target.closest('.theme-card');
  if (card) useTheme(allThemes()[+card.dataset.i]);
});

function buildThemeEditor() {
  $('#theme-colors').innerHTML = THEME_COLOR_KEYS.map(([k, label]) => `<label>${label}<input type="color" data-key="${k}"></label>`).join('');
  $('#theme-colors').addEventListener('input', (e) => {
    const k = e.target.dataset.key;
    if (!k) return;
    editTheme({ [k]: e.target.value });
  });
  const ranges = [
    ['#t-radius', 'radius', (v) => v + 'px', '#radius-val'],
    ['#t-alpha', 'alpha', (v) => Math.round(v * 100) + '%', '#alpha-val'],
    ['#t-scale', 'scale', (v) => Math.round(v * 100) + '%', '#scale-val'],
    ['#t-bgblur', 'bgBlur', (v) => v + 'px', '#bgblur-val'],
  ];
  for (const [sel, key, label, lab] of ranges) {
    const el = $(sel);
    el.addEventListener('input', () => { $(lab).textContent = label(+el.value); editTheme({ [key]: +el.value }); });
    el.addEventListener('sync', () => { $(lab).textContent = label(+el.value); });
  }
  $('#t-font').addEventListener('change', (e) => editTheme({ font: e.target.value }));
  $('#t-css').addEventListener('input', (e) => editTheme({ css: e.target.value }));
  $('#t-bg-pick').onclick = async () => { const p = await api.pickImage(); if (p) editTheme({ bgImage: p }); };
  $('#t-bg-clear').onclick = () => editTheme({ bgImage: '' });
  $('#t-save').onclick = () => {
    const name = $('#t-name').value.trim() || `My theme ${S.customThemes.length + 1}`;
    if (PRESET_THEMES.some((p) => p.name === name)) return osd('That name belongs to a built-in theme');
    const t = { ...currentTheme(), name };
    delete t.preset;
    S.customThemes = S.customThemes.filter((x) => x.name !== name).concat(t);
    S.themeName = name;
    S.theme = t;
    $('#t-name').value = '';
    refreshTheme(); save();
    osd(`Saved theme “${name}”`);
  };
  $('#theme-export').onclick = () => api.exportTheme({ ...currentTheme(), bgImage: '' });
  $('#theme-import').onclick = async () => {
    const t = await api.importTheme();
    if (!t || !t.bg || !t.accent) return osd('That file is not a JS Player theme');
    t.name = t.name || 'Imported';
    delete t.preset;
    S.customThemes = S.customThemes.filter((x) => x.name !== t.name).concat(t);
    useTheme(t);
    osd(`Imported “${t.name}”`);
  };
}
let editingTimer;
function editTheme(patch) {
  S.theme = { ...currentTheme(), ...patch };
  delete S.theme.preset;
  if (!S.themeName.endsWith(' (edited)') && !S.customThemes.some((t) => t.name === S.themeName)) S.themeName = S.themeName + ' (edited)';
  S.theme.name = S.themeName;
  // also update the saved custom theme if we're editing one
  const ci = S.customThemes.findIndex((t) => t.name === S.themeName);
  if (ci >= 0) S.customThemes[ci] = { ...S.theme };
  applyTheme(S.theme);
  viz.refreshColors();
  clearTimeout(editingTimer);
  editingTimer = setTimeout(() => { renderThemeList(); $$('input[type=range]').forEach(updateRange); }, 150);
  save();
}
function syncThemeEditor(t) {
  $$('#theme-colors input').forEach((el) => { el.value = t[el.dataset.key]; });
  const set = (sel, v) => { const el = $(sel); el.value = v; updateRange(el); el.dispatchEvent(new Event('sync')); };
  set('#t-radius', t.radius); set('#t-alpha', t.alpha); set('#t-scale', t.scale); set('#t-bgblur', t.bgBlur);
  const font = $('#t-font');
  font.value = t.font;
  if (font.value !== t.font) { font.add(new Option('Custom', t.font)); font.value = t.font; }
  if (document.activeElement !== $('#t-css')) $('#t-css').value = t.css || '';
}

// ---------------------------------------------------------------- settings UI
function buildSettings() {
  bindCheck('#s-resume', () => S.resume, (v) => { S.resume = v; if (!v) S.positions = {}; });
  bindCheck('#s-autoplay', () => S.autoplay, (v) => { S.autoplay = v; });
  bindCheck('#s-autoconvert', () => S.autoconvert, (v) => { S.autoconvert = v; });
  bindCheck('#s-autosubs', () => S.autosubs, (v) => { S.autosubs = v; });
  bindCheck('#s-ontop', () => S.onTop, (v) => { S.onTop = v; api.windowCmd('always-on-top', v); });
  bindCheck('#s-autohide', () => S.autohide, (v) => { S.autohide = v; $('#controls').classList.toggle('autohide', fs && v); });
  bindRange('#s-seek', () => S.seekStep, (v) => { S.seekStep = v; }, (v) => v + 's', '#seek-val');
  bindRange('#s-subsize', () => S.sub.size, (v) => { S.sub.size = v; }, (v) => v + '%', '#sub-size-val', applySubStyle);
  bindRange('#s-subbga', () => S.sub.bga, (v) => { S.sub.bga = v; }, (v) => Math.round(v * 100) + '%', '#sub-bga-val', applySubStyle);
  $('#s-subcolor').value = S.sub.color;
  $('#s-subbg').value = S.sub.bg;
  $('#s-subcolor').addEventListener('input', (e) => { S.sub.color = e.target.value; applySubStyle(); save(); });
  $('#s-subbg').addEventListener('input', (e) => { S.sub.bg = e.target.value; applySubStyle(); save(); });
  bindRange('#s-slide', () => S.img.interval, (v) => { S.img.interval = v; }, (v) => v + 's per image', '#slide-val', () => armSlideshow());
  for (const [sel, key] of [['#s-trans', 'transition'], ['#s-imgbg', 'bg']]) {
    $(sel).value = S.img[key];
    $(sel).addEventListener('change', (e) => { S.img[key] = e.target.value; applyImageSettings(); save(); });
  }
  bindCheck('#s-upscale', () => S.img.upscale, (v) => { S.img.upscale = v; }, () => { if (IV.active && IV.fit) fitView(true); });
  bindCheck('#s-strip', () => S.img.strip, (v) => { S.img.strip = v; }, applyImageSettings);
  $('#s-cache-open').onclick = () => api.openCache();
  $('#s-cache-clear').onclick = async () => { const b = await api.clearCache(); osd(`Freed ${(b / 1048576).toFixed(1)} MB`); };
  api.ffmpegStatus().then((s) => {
    $('#ffmpeg-status').textContent = s.ok
      ? 'ffmpeg found — files your system can\'t play natively get converted once and cached here.'
      : 'ffmpeg not found. Install it (winget install ffmpeg) to play every format.';
  });
}

// ---------------------------------------------------------------- boot
function merge(def, val) {
  if (val == null) return def;
  if (def == null) return val; // no default type to check against (e.g. feeds.last)
  if (Array.isArray(def)) return Array.isArray(val) ? val : def;
  if (typeof def === 'object' && def) {
    const o = { ...def };
    for (const k of Object.keys(val)) o[k] = k in def ? merge(def[k], val[k]) : val[k];
    return o;
  }
  return typeof val === typeof def ? val : def;
}

(async function boot() {
  // wait until imageviewer.js (loaded after this file) has run
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
  S = merge(structuredClone(DEFAULTS), await api.getSettings());
  delete S.window;
  S.playlist.forEach((it) => delete it._probed);
  refreshTheme();
  buildEq();
  syncEq();
  buildVizUI();
  syncViz();
  buildThemeEditor();
  syncThemeEditor(currentTheme());
  buildSettings();
  applySubStyle();
  syncVolumeUI();
  syncModeButtons();
  $('#b-speed').textContent = S.speed.toFixed(2) + '×';
  toggleSidebar(S.sidebar);
  selectTab(S.tab);
  if (S.onTop) api.windowCmd('always-on-top', true);
  renderPlaylist();
  queueProbe();
  initFeeds();

  const launch = await api.getLaunchFiles();
  if (launch.length) addFiles(launch, true);
  else if (S.index >= 0 && S.playlist[S.index]) load(S.index, { autoplay: false });
  else showEmptyIfNeeded();
  api.onOpenFiles((files) => addFiles(files, true));
})();

// handy for scripting/tests
window.__prism = {
  addFiles, load, setVizMode, useTheme, selectTab, toggleSidebar, get state() { return S; }, video,
  feeds: { setMode: (m) => setMode(m), open: (id, url) => openFeed(id, url), home: () => showFeedHome(), setAutoNext: (on) => setAutoNext(on), view: (id) => FD.views.get(id), get state() { return FD; } },
  img: { zoomTo: (...a) => zoomTo(...a), rotate: (d) => rotate(d), toggleSlideshow: (f) => toggleSlideshow(f), toggleInfo: () => toggleInfo(), get view() { return IV; } },
};
