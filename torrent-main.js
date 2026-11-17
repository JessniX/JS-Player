// Built-in torrent streaming (like Stremio's streaming server), using WebTorrent.
// - Plays a file while it downloads: reads go to the needed pieces first.
// - One torrent at a time; its data is deleted when you move on (unless you choose to keep it).
// - Files are served two ways: prism://app/torrent/<hash>/<idx> for the player (same origin, so the
//   equalizer/visualizer work) and http://127.0.0.1:<port>/<hash>/<idx> for ffmpeg (probing / live conversion).

const { app, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

// Public trackers, added to the ones a stream lists (Stremio does the same). DHT is on as well.
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
];
const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|webm|mov|ts|m2ts|mts|wmv|flv|mpe?g|ogv|3gp)$/i;
const MIME = { mkv: 'video/webm', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', avi: 'video/x-msvideo', ts: 'video/mp2t' };

let client = null;
let server = null;
let port = 0;
let opts = { uploadKBs: 500, keepData: false };
let current = null; // { hash, torrent, file, idx }

const cachePath = () => path.join(app.getPath('userData'), 'torrent-cache');
const cacheDir = () => { const d = cachePath(); fs.mkdirSync(d, { recursive: true }); return d; };

async function getClient() {
  if (client) return client;
  const { default: WebTorrent } = await import('webtorrent');
  client = new WebTorrent({ maxConns: 80, uploadLimit: opts.uploadKBs > 0 ? opts.uploadKBs * 1024 : -1 });
  client.on('error', (e) => console.error('[torrent]', e && e.message));
  return client;
}

function rangeStream(file, rangeHeader) {
  const size = file.length;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (m && (m[1] || m[2])) {
    let start, end;
    if (!m[1]) { start = Math.max(0, size - +m[2]); end = size - 1; }
    else { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
    if (start >= size || start > end) return { status: 416, headers: { 'Content-Range': `bytes */${size}` } };
    return { status: 206, start, end, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } };
  }
  return { status: 200, start: 0, end: size - 1, headers: { 'Content-Length': String(size) } };
}
const typeOf = (file) => MIME[(file.name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

function findFile(hash, idx) {
  if (!current || current.hash !== hash) return null;
  return current.torrent.files[idx] || null;
}

// local HTTP server for ffmpeg
function ensureServer() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const m = /^\/([a-f0-9]{40})\/(\d+)/i.exec(req.url || '');
      const file = m && findFile(m[1].toLowerCase(), +m[2]);
      if (!file) { res.writeHead(404); return res.end(); }
      const r = rangeStream(file, req.headers.range);
      res.writeHead(r.status, { 'Content-Type': typeOf(file), 'Accept-Ranges': 'bytes', ...r.headers });
      if (r.status === 416 || req.method === 'HEAD') return res.end();
      const s = file.createReadStream({ start: r.start, end: r.end });
      s.on('error', () => res.destroy());
      res.on('close', () => s.destroy());
      s.pipe(res);
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });
}

// prism://app/torrent/<hash>/<idx> for the player
function torrentResponse(req, url) {
  const m = /^\/torrent\/([a-f0-9]{40})\/(\d+)/i.exec(url.pathname);
  const file = m && findFile(m[1].toLowerCase(), +m[2]);
  if (!file) return new Response('Not found', { status: 404 });
  const r = rangeStream(file, req.headers.get('range'));
  const headers = { 'Content-Type': typeOf(file), 'Accept-Ranges': 'bytes', ...r.headers };
  if (r.status === 416) return new Response(null, { status: 416, headers });
  const s = file.createReadStream({ start: r.start, end: r.end });
  return new Response(Readable.toWeb(Readable.from(s)), { status: r.status, headers });
}

function stopCurrent() {
  if (!current) return;
  const t = current.torrent;
  current = null;
  try { t.destroy({ destroyStore: !opts.keepData }); } catch { /* already gone */ }
}

function waitForMetadata(torrent, ms) {
  if (torrent.files && torrent.files.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Nobody is sharing this torrent right now, so it couldn't start. Try another stream.")); }, ms);
    const done = () => { cleanup(); resolve(); };
    const fail = (e) => { cleanup(); reject(e); };
    const cleanup = () => { clearTimeout(timer); torrent.removeListener('metadata', done); torrent.removeListener('ready', done); torrent.removeListener('error', fail); };
    torrent.once('metadata', done);
    torrent.once('ready', done);
    torrent.once('error', fail);
  });
}

async function start({ infoHash, fileIdx, trackers = [], name }) {
  const hash = String(infoHash || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error("That stream's torrent ID isn't valid.");
  const c = await getClient();
  await ensureServer();
  if (current && current.hash !== hash) stopCurrent();
  let torrent = current && current.hash === hash ? current.torrent : await c.get(hash);
  if (!torrent) {
    const announce = [...new Set([...trackers.filter((t) => /^(udp|https?|wss?):\/\//.test(t)), ...TRACKERS])];
    torrent = c.add(`magnet:?xt=urn:btih:${hash}${name ? '&dn=' + encodeURIComponent(name) : ''}`, { path: cacheDir(), announce, destroyStoreOnDestroy: !opts.keepData });
  }
  current = { hash, torrent, file: null, idx: -1 };
  await waitForMetadata(torrent, 45000);
  if (!current || current.hash !== hash) throw new Error('Cancelled');
  const files = torrent.files;
  let idx = Number.isInteger(fileIdx) && fileIdx >= 0 && fileIdx < files.length ? fileIdx : -1;
  if (idx < 0) { // the largest video file
    let best = -1;
    files.forEach((f, i) => { if (VIDEO_EXT.test(f.name) && (best < 0 || f.length > files[best].length)) best = i; });
    idx = best >= 0 ? best : files.reduce((b, f, i) => (f.length > files[b].length ? i : b), 0);
  }
  const file = files[idx];
  files.forEach((f, i) => { if (i !== idx) f.deselect(); });
  file.select();
  current.file = file;
  current.idx = idx;
  return {
    hash, idx, name: file.name, size: file.length,
    playerUrl: `prism://app/torrent/${hash}/${idx}`,
    localUrl: `http://127.0.0.1:${port}/${hash}/${idx}`,
    fileBase: `http://127.0.0.1:${port}/${hash}/`, // other files in the torrent (e.g. subtitles) by index
    files: files.map((f, i) => ({ i, name: f.name, length: f.length })),
  };
}

function status() {
  if (!current) return null;
  const t = current.torrent;
  const f = current.file;
  return {
    hash: current.hash, peers: t.numPeers || 0, down: Math.round(t.downloadSpeed || 0), up: Math.round(t.uploadSpeed || 0),
    progress: f ? f.progress : t.progress || 0, ready: !!f, name: f ? f.name : t.name || '',
  };
}

function setupTorrents() {
  // leftovers from a previous run that didn't close cleanly
  try { if (!opts.keepData) fs.rmSync(cachePath(), { recursive: true, force: true }); } catch {}
  ipcMain.handle('torrent-start', async (_e, args) => {
    try { return await start(args || {}); } catch (e) { return { error: String(e && e.message || e) }; }
  });
  ipcMain.handle('torrent-status', () => status());
  ipcMain.handle('torrent-stop', () => { stopCurrent(); return true; });
  ipcMain.handle('torrent-options', (_e, o) => {
    opts = { ...opts, ...(o || {}) };
    if (client) client.throttleUpload(opts.uploadKBs > 0 ? opts.uploadKBs * 1024 : -1);
    return opts;
  });
  app.on('will-quit', () => {
    stopCurrent();
    try { client && client.destroy(); } catch {}
    try { server && server.close(); } catch {}
    try { if (!opts.keepData) fs.rmSync(cachePath(), { recursive: true, force: true }); } catch {}
  });
}

module.exports = { setupTorrents, torrentResponse };
