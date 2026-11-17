// Stremio add-on support (main process side).
// Stremio add-ons are plain HTTP + JSON services (manifest.json, /catalog, /meta, /stream, /subtitles).
// The window can't reach other sites itself (its security policy only allows JS Player's own files),
// so add-on requests go through here. Streams are relayed through prism://app/remote so the
// player's equalizer and visualizer keep working (they need same-origin audio).

const { app, ipcMain, net, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// ---- Stremio account (sync add-ons and library with your Stremio account)
// Your password is sent only to Stremio (api.strem.io) and never saved. The sign-in key Stremio
// returns is kept on this PC encrypted with Windows' data protection (safeStorage), and only this
// main process uses it: the window never sees it.
const STREMIO_API = 'https://api.strem.io/api/';
const authFile = () => path.join(app.getPath('userData'), 'stremio-account.bin');
function readAuth() {
  try {
    const buf = fs.readFileSync(authFile());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : null;
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}
function writeAuth(data) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("This PC can't store the sign-in securely.");
  fs.writeFileSync(authFile(), safeStorage.encryptString(JSON.stringify(data)));
}
async function stremioCall(method, body) {
  const res = await net.fetch(STREMIO_API + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  let j;
  try { j = await res.json(); } catch { throw new Error(`Stremio answered with HTTP ${res.status}`); }
  if (j && j.error) throw new Error(j.error.message || (typeof j.error === 'string' ? j.error : 'Stremio returned an error'));
  return j ? j.result : null;
}
function withAuth(fn) {
  return async (_e, ...args) => {
    const auth = readAuth();
    if (!auth) return { error: 'Not signed in to Stremio' };
    try { return { ok: true, data: await fn(auth.authKey, ...args) }; }
    catch (e) {
      const msg = String(e.message || e);
      if (/session|auth/i.test(msg) && /not|invalid|expired|exist/i.test(msg)) { try { fs.unlinkSync(authFile()); } catch {} return { error: 'Your Stremio sign-in expired. Please sign in again.', signedOut: true }; }
      return { error: msg };
    }
  };
}
function setupStremioAccount() {
  ipcMain.handle('stremio-account', () => { const a = readAuth(); return a ? { signedIn: true, email: a.email } : { signedIn: false }; });
  ipcMain.handle('stremio-login', async (_e, email, password) => {
    try {
      if (!email || !password) throw new Error('Enter your Stremio email and password.');
      const r = await stremioCall('login', { type: 'Login', email, password, facebook: false });
      if (!r || !r.authKey) throw new Error("Stremio didn't accept the sign-in.");
      writeAuth({ authKey: r.authKey, email: (r.user && r.user.email) || email });
      return { ok: true, email: (r.user && r.user.email) || email };
    } catch (e) { return { error: String(e.message || e) }; }
  });
  ipcMain.handle('stremio-logout', async () => {
    const a = readAuth();
    if (a) { try { await stremioCall('logout', { type: 'Logout', authKey: a.authKey }); } catch { /* still sign out here */ } }
    try { fs.unlinkSync(authFile()); } catch {}
    return true;
  });
  ipcMain.handle('stremio-addons-get', withAuth(async (authKey) => (await stremioCall('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true })).addons || []));
  ipcMain.handle('stremio-addons-set', withAuth(async (authKey, addons) => stremioCall('addonCollectionSet', { type: 'AddonCollectionSet', authKey, addons })));
  ipcMain.handle('stremio-library-get', withAuth(async (authKey) => stremioCall('datastoreGet', { authKey, collection: 'libraryItem', ids: [], all: true })));
  ipcMain.handle('stremio-library-put', withAuth(async (authKey, changes) => stremioCall('datastorePut', { authKey, collection: 'libraryItem', changes })));
}

const MAX_BYTES = 8 * 1024 * 1024;
const isHttp = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

async function fetchText(url, timeoutMs = 15000) {
  if (!isHttp(url)) throw new Error('Only http(s) add-on links are supported');
  const res = await net.fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json, text/plain, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('Response too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('Response too large');
  return buf.toString('utf8');
}

// prism://app/remote?u=<url>&h=<json headers>: streams a remote file with Range support.
async function remoteResponse(req, url) {
  const target = url.searchParams.get('u');
  if (!target || !isHttp(target)) return new Response('Bad request', { status: 400 });
  let headers = {};
  try { headers = JSON.parse(url.searchParams.get('h') || '{}') || {}; } catch { headers = {}; }
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  let res;
  try { res = await net.fetch(target, { headers }); } catch (e) { return new Response(String(e.message || e), { status: 502 }); }
  const out = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = res.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  return new Response(res.body, { status: res.status, headers: out });
}

// ---- Stremio's own streaming server (the engine Stremio uses for torrents)
// It isn't bundled (it's Stremio's own software). If the Stremio app is installed on this PC,
// JS Player starts its server in the background when needed, and stops it again on quit.
const { spawn, spawnSync } = require('child_process');
let serverProc = null;
let serverBase = null;
const ourTorrents = new Set(); // torrents JS Player opened on the server, removed again when you move on or quit
// The PID of the server JS Player started, so a run that crashed can clean it up next time.
const pidFile = () => path.join(app.getPath('userData'), 'stremio-server.json');
function writePid(pid) { try { fs.writeFileSync(pidFile(), JSON.stringify({ pid, at: Date.now() })); } catch {} }
function clearPid() { try { fs.rmSync(pidFile(), { force: true }); } catch {} }
// End a process and everything it started (on Windows, kill() alone leaves its children running).
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch {}
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
// Only a server JS Player itself started is ever stopped; one the Stremio app runs is left alone.
function cleanupLeftoverServer() {
  let pid;
  try { pid = JSON.parse(fs.readFileSync(pidFile(), 'utf8')).pid; } catch { return; }
  if (Number.isInteger(pid) && process.platform === 'win32') {
    try {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).stdout || '';
      if (/^"(stremio-runtime|node)\.exe"/im.test(out.trim())) killTree(pid);
    } catch {}
  }
  clearPid();
}
async function removeTorrent(base, hash) {
  if (!isHttp(base) || !/^[a-f0-9]{40}$/i.test(hash || '')) return false;
  ourTorrents.delete(hash.toLowerCase());
  try { await net.fetch(new URL(`/${hash}/remove`, base).href, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}
function findInstalledStremio() {
  const L = process.env.LOCALAPPDATA || '', P = process.env.ProgramFiles || '', P86 = process.env['ProgramFiles(x86)'] || '';
  const dirs = [path.join(L, 'Programs', 'LNV', 'Stremio-4'), path.join(L, 'Programs', 'LNV', 'Stremio-5'), path.join(L, 'Programs', 'LNV', 'Stremio'),
    path.join(L, 'Programs', 'Stremio'), path.join(P, 'Stremio'), path.join(P86, 'Stremio'), path.join(P, 'LNV', 'Stremio-4')];
  for (const dir of dirs) {
    const script = path.join(dir, 'server.js');
    const runtime = ['stremio-runtime.exe', 'node.exe'].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
    if (runtime && fs.existsSync(script)) return { dir, script, runtime };
  }
  return null;
}
async function serverUp(base) {
  try { const r = await net.fetch(new URL('/settings', base).href, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
async function ensureStremioServer(base) {
  if (!isHttp(base)) return { ok: false, error: 'The streaming server address in Settings isn\'t valid.' };
  if (await serverUp(base)) return { ok: true, started: false };
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(base)) return { ok: false, error: "The Stremio streaming server at that address isn't answering." };
  const inst = findInstalledStremio();
  if (!inst) return { ok: false, notInstalled: true, error: "Stremio isn't installed on this PC, so its streaming engine can't be used." };
  if (!serverProc) {
    serverProc = spawn(inst.runtime, [inst.script], { cwd: inst.dir, windowsHide: true, stdio: 'ignore' });
    if (serverProc.pid) writePid(serverProc.pid);
    serverProc.on('exit', () => { serverProc = null; clearPid(); });
    serverProc.on('error', () => { serverProc = null; clearPid(); });
  }
  for (let i = 0; i < 40; i++) { // up to ~20 s
    await new Promise((r) => setTimeout(r, 500));
    if (await serverUp(base)) return { ok: true, started: true };
    if (!serverProc) break;
  }
  return { ok: false, error: "Stremio's streaming engine didn't start. Try opening the Stremio app once, or switch Settings → Torrent streams to Built-in." };
}
function setupStremioServer() {
  cleanupLeftoverServer();
  ipcMain.handle('stremio-installed', () => !!findInstalledStremio());
  ipcMain.handle('stremio-server-ensure', (_e, base) => ensureStremioServer(base));
  // Open a torrent on the server the way Stremio's own player does, telling it where to find peers.
  ipcMain.handle('stremio-server-create', async (_e, base, infoHash, sources) => {
    if (!/^[a-f0-9]{40}$/i.test(infoHash || '') || !isHttp(base)) return { ok: false, error: 'Invalid torrent' };
    try {
      const res = await net.fetch(new URL(`/${infoHash}/create`, base).href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
        body: JSON.stringify({ torrent: { infoHash }, peerSearch: { sources, min: 40, max: 150 }, guessFileIdx: {} }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ourTorrents.add(infoHash.toLowerCase());
      serverBase = base;
      const j = await res.json();
      return { ok: true, files: (j.files || []).map((f, i) => ({ i, name: f.name, length: f.length })), guessedFileIdx: j.guessedFileIdx };
    } catch (e) {
      const msg = String(e.message || e);
      return { ok: false, error: /timed? ?out|aborted/i.test(msg) ? "Nobody is sharing this torrent right now, so it couldn't start. Try another stream." : msg };
    }
  });
  ipcMain.handle('stremio-server-remove', (_e, base, infoHash) => removeTorrent(base, infoHash));
  // On quit: stop the torrents JS Player opened (so a Stremio app that's running doesn't keep
  // sharing them), then end the server JS Player started, with everything it started.
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || (!ourTorrents.size && !serverProc)) return;
    quitting = true;
    e.preventDefault();
    const base = serverBase;
    Promise.race([
      Promise.all([...ourTorrents].map((h) => removeTorrent(base, h))),
      new Promise((r) => setTimeout(r, 1500)),
    ]).finally(() => {
      if (serverProc) { killTree(serverProc.pid); serverProc = null; }
      clearPid();
      app.quit();
    });
  });
  app.on('will-quit', () => { if (serverProc) { killTree(serverProc.pid); serverProc = null; clearPid(); } });
}

function setupStremio() {
  setupStremioAccount();
  setupStremioServer();
  ipcMain.handle('addon-fetch', async (_e, url, as = 'json') => {
    try {
      const text = await fetchText(url);
      return { ok: true, data: as === 'text' ? text : JSON.parse(text) };
    } catch (e) {
      const msg = String(e && e.message || e);
      return { ok: false, error: /timed? ?out|aborted/i.test(msg) ? 'The add-on took too long to answer' : msg };
    }
  });

  // Is the Stremio streaming server (part of the Stremio app) running? It plays torrent streams.
  ipcMain.handle('stremio-server', async (_e, base) => {
    if (!isHttp(base)) return { ok: false };
    try {
      const res = await net.fetch(new URL('/settings', base).href, { signal: AbortSignal.timeout(2000) });
      return { ok: res.ok };
    } catch { return { ok: false }; }
  });
}

module.exports = { setupStremio, remoteResponse };
