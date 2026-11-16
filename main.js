// Prism Player — main process
// Serves the UI and local media over a private "prism://" scheme (so Web Audio
// visualizers work without CORS problems), probes/converts files with ffmpeg,
// and stores settings in the user's app-data folder.

const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { setupFeeds } = require('./feeds-main');

const SMOKE = process.argv.includes('--smoke');
if (SMOKE) app.setPath('userData', path.join(app.getPath('temp'), 'prism-player-smoke'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'prism', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const UI_DIR = path.join(__dirname, 'src');

const MEDIA_EXT = new Set([
  // video
  'mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm2ts', 'mts', 'mpg', 'mpeg', 'vob', '3gp', 'ogv', 'divx', 'xvid', 'rm', 'rmvb', 'asf', 'f4v',
  // audio
  'mp3', 'flac', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aiff', 'aif', 'alac', 'ape', 'wv', 'mka', 'ac3', 'dts', 'amr', 'mid', 'midi', 'tta', 'dsf', 'dff',
]);

// images Chromium shows natively, plus formats we convert with ffmpeg
const IMAGE_NATIVE = ['jpg', 'jpeg', 'jfif', 'pjpeg', 'png', 'apng', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'];
const IMAGE_CONVERT = ['tif', 'tiff', 'heic', 'heif', 'tga', 'psd', 'dds', 'exr', 'hdr', 'pcx', 'ppm', 'pgm', 'pbm', 'pnm', 'sgi', 'jp2', 'j2k', 'jxl', 'qoi', 'xbm', 'dpx'];
const IMAGE_EXT = new Set([...IMAGE_NATIVE, ...IMAGE_CONVERT]);

const MIME = {
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.apng': 'image/apng', '.jfif': 'image/jpeg',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.vtt': 'text/vtt',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac',
};

let win = null;
function dbg(...a) {
  if (!process.env.PRISM_DEBUG) return;
  try { fs.appendFileSync(process.env.PRISM_DEBUG, `${new Date().toISOString()} ${a.join(' ')}\n`); } catch {}
}
dbg('main start', process.argv.join(' '));
let launchFiles = [];
let currentJob = null;

// ---------- paths ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const cacheDir = () => {
  const d = path.join(app.getPath('userData'), 'cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function ffmpegPath() {
  try {
    const p = require('ffmpeg-static');
    if (p) {
      const unpacked = p.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) return unpacked;
    }
  } catch { /* not installed */ }
  return 'ffmpeg'; // fall back to ffmpeg on PATH
}

const isMedia = (p) => MEDIA_EXT.has(path.extname(p).slice(1).toLowerCase());
const isImage = (p) => IMAGE_EXT.has(path.extname(p).slice(1).toLowerCase());
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('--') && fs.existsSync(a) && a !== '.');
}

// Files are kept as given. A folder contributes its audio/video, or, if it has none
// (a photo folder), its images, so album folders don't fill the playlist with cover.jpg.
async function expandPaths(paths) {
  const out = [];
  async function walk(p, depth, acc) {
    let st;
    try { st = await fs.promises.stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > 8) return;
      const entries = await fs.promises.readdir(p).catch(() => []);
      entries.sort(byName);
      for (const e of entries) await walk(path.join(p, e), depth + 1, acc);
    } else if (isMedia(p)) acc.media.push(p);
    else if (isImage(p)) acc.images.push(p);
  }
  for (const p of paths) {
    let st;
    try { st = await fs.promises.stat(p); } catch { continue; }
    if (st.isDirectory()) {
      const acc = { media: [], images: [] };
      await walk(p, 0, acc);
      out.push(...(acc.media.length ? acc.media : acc.images));
    } else if (isMedia(p) || isImage(p)) {
      out.push(p);
    }
  }
  return out;
}

async function imageSiblings(file) {
  const dir = path.dirname(file);
  const entries = await fs.promises.readdir(dir).catch(() => []);
  return entries.filter(isImage).sort(byName).map((e) => path.join(dir, e));
}

// ---------- prism:// protocol (UI + ranged media streaming) ----------
async function serveFile(file, req) {
  let st;
  try { st = await fs.promises.stat(file); } catch { return new Response('Not found', { status: 404 }); }
  if (!st.isFile()) return new Response('Not found', { status: 404 });
  const size = st.size;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start, end;
    if (!m[1]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    else { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1; }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function registerProtocol() {
  protocol.handle('prism', async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/media') {
      const p = url.searchParams.get('p');
      return p ? serveFile(p, req) : new Response('Bad request', { status: 400 });
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.normalize(path.join(UI_DIR, rel));
    if (!full.startsWith(UI_DIR)) return new Response('Forbidden', { status: 403 });
    return serveFile(full, req);
  });
}

// ---------- ffmpeg helpers ----------
function runFfmpeg(args, onStderr) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(ffmpegPath(), args, { windowsHide: true }); } catch { return resolve({ code: -1, err: 'spawn failed', proc: null }); }
    let err = '';
    proc.stderr.on('data', (d) => { const s = d.toString(); err += s; if (err.length > 200000) err = err.slice(-100000); onStderr && onStderr(s); });
    proc.on('error', () => resolve({ code: -1, err: 'ffmpeg not found', proc }));
    proc.on('close', (code) => resolve({ code, err, proc }));
    if (onStderr) onStderr.proc = proc;
    runFfmpeg.last = proc;
  });
}

const hms = (s) => { const [h, m, sec] = s.split(':').map(parseFloat); return h * 3600 + m * 60 + sec; };

function parseProbe(text) {
  const info = { duration: 0, metadata: {}, streams: [], ok: /Input #0/.test(text) };
  const d = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(text);
  if (d) info.duration = hms(d[1]);
  // container-level metadata sits between "Input #0" and "Duration:"
  const head = text.split(/Duration:/)[0].split(/Input #0/)[1] || '';
  for (const line of head.split(/\r?\n/)) {
    const mm = /^\s{4}([A-Za-z_\-]+)\s*:\s(.*)$/.exec(line);
    if (mm) {
      const k = mm[1].toLowerCase();
      if (!(k in info.metadata)) info.metadata[k] = mm[2].trim();
    }
  }
  const re = /Stream #0:(\d+)[^:]*: (Video|Audio|Subtitle): ([a-z0-9_]+)([^\n]*)/g;
  let s;
  while ((s = re.exec(text))) {
    const rest = s[4];
    const res = /, (\d{2,5})x(\d{2,5})/.exec(rest);
    info.streams.push({
      index: +s[1], type: s[2], codec: s[3],
      attached: /attached pic/.test(rest),
      width: res ? +res[1] : 0, height: res ? +res[2] : 0,
      lang: (/Stream #0:\d+\((\w+)\)/.exec(s[0]) || [])[1] || '',
    });
  }
  return info;
}

async function probe(file) {
  const { err } = await runFfmpeg(['-hide_banner', '-i', file]);
  const info = parseProbe(err || '');
  info.hasVideo = info.streams.some((s) => s.type === 'Video' && !s.attached);
  info.hasCover = info.streams.some((s) => s.type === 'Video' && s.attached);
  info.ffmpeg = !/ffmpeg not found|spawn failed/.test(err || '') && info.ok;
  return info;
}

function cacheKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
}

async function extractCover(file) {
  try {
    const out = path.join(cacheDir(), `cover-${cacheKey(file)}.jpg`);
    if (fs.existsSync(out)) return out;
    const { code } = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=600:-2', out]);
    return code === 0 && fs.existsSync(out) ? out : null;
  } catch { return null; }
}

const VIDEO_OK = new Set(['h264', 'vp8', 'vp9', 'av1']);
const AUDIO_OK = new Set(['aac', 'mp3', 'opus']);

async function transcode(file, sender) {
  if (currentJob) { try { currentJob.kill(); } catch {} currentJob = null; }
  const info = await probe(file);
  if (!info.ffmpeg) throw new Error('ffmpeg was not found. Install it (winget install ffmpeg) or run npm install.');
  const v = info.streams.find((s) => s.type === 'Video' && !s.attached);
  const a = info.streams.find((s) => s.type === 'Audio');
  const out = path.join(cacheDir(), `${cacheKey(file)}${v ? '.mp4' : '.m4a'}`);
  if (fs.existsSync(out)) return { path: out, cached: true };
  const tmp = out + '.part' + (v ? '.mp4' : '.m4a');

  const args = ['-y', '-hide_banner', '-i', file];
  if (v) {
    args.push('-map', `0:${v.index}`);
    if (a) args.push('-map', `0:${a.index}`);
    if (VIDEO_OK.has(v.codec)) args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  } else {
    if (!a) throw new Error('No playable audio or video streams in this file.');
    args.push('-map', `0:${a.index}`, '-vn');
  }
  if (a) {
    if (AUDIO_OK.has(a.codec) && v) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2');
  }
  args.push('-sn', '-movflags', '+faststart', tmp);

  const dur = info.duration || 0;
  const onErr = (chunk) => {
    const t = /time=(\d+:\d+:\d+(?:\.\d+)?)/.exec(chunk);
    if (t && dur && !sender.isDestroyed()) sender.send('transcode-progress', Math.min(1, hms(t[1]) / dur));
  };
  const job = runFfmpeg(args, onErr);
  currentJob = runFfmpeg.last;
  const { code, err } = await job;
  currentJob = null;
  if (code !== 0) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(code === null ? 'Conversion cancelled' : 'ffmpeg failed: ' + (err || '').split(/\r?\n/).filter(Boolean).slice(-2).join(' '));
  }
  fs.renameSync(tmp, out);
  return { path: out, cached: false };
}

// ---------- settings ----------
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
let saveTimer = null;
function saveSettings(data) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = settingsFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, settingsFile());
    } catch (e) { console.error('settings save failed', e); }
  }, 250);
}

// ---------- window ----------
function createWindow() {
  const s = loadSettings();
  const b = s.window || {};
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 760, x: b.x, y: b.y,
    minWidth: 640, minHeight: 400,
    backgroundColor: '#0d0f16',
    title: 'Prism Player',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#00000000', symbolColor: '#e6e8f0', height: 38 },
    trafficLightPosition: { x: 12, y: 12 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      webviewTag: true, // for Feeds (locked down in feeds-main.js)
    },
  });
  dbg('window created', JSON.stringify(b));
  if (b.maximized) win.maximize();
  // 'ready-to-show' doesn't always fire (e.g. with backgroundThrottling off), so also show on load and after a timeout
  const reveal = (why) => {
    if (!win || win.isDestroyed() || win.isVisible() || SMOKE) return;
    dbg('showing window via', why);
    win.show();
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  win.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  setTimeout(() => reveal('timeout'), 3000);
  win.webContents.on('did-fail-load', (_e, code, desc) => dbg('did-fail-load', code, desc));
  win.webContents.on('render-process-gone', (_e, d) => dbg('render-process-gone', JSON.stringify(d)));
  win.loadURL('prism://app/index.html');

  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const cur = loadSettings();
    cur.window = { ...(win.isMaximized() || win.isFullScreen() ? cur.window : win.getBounds()), maximized: win.isMaximized() };
    saveSettings(cur);
  };
  win.on('close', remember);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (SMOKE) smokeTest();
}

// --smoke: load, optionally play the file passed on the command line, capture a screenshot, quit.
function smokeTest() {
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });
  win.webContents.once('did-finish-load', async () => {
    if (process.env.PRISM_SMOKE_SHOW) win.showInactive(); // embedded pages only run at full speed in a visible window
    const shotDir = process.env.PRISM_SMOKE_DIR || app.getPath('temp');
    const steps = (process.env.PRISM_SMOKE_STEPS || '').split('|||').filter(Boolean);
    await new Promise((r) => setTimeout(r, 4000));
    let i = 0;
    const snap = async (name) => {
      const img = await win.webContents.capturePage();
      const out = path.join(shotDir, `prism-smoke-${name}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log('[smoke] screenshot', out);
    };
    await snap('0');
    for (const js of steps) {
      i++;
      try { const r = await win.webContents.executeJavaScript(js); if (r !== undefined) console.log('[smoke] step', i, JSON.stringify(r)); }
      catch (e) { console.log('[smoke] step error', i, e.message); }
      await new Promise((r) => setTimeout(r, 1800));
      await snap(String(i));
    }
    app.quit();
  });
}

// ---------- IPC ----------
const MEDIA_FILTERS = [
  { name: 'Media & images', extensions: [...MEDIA_EXT, ...IMAGE_EXT] },
  { name: 'Video & audio', extensions: [...MEDIA_EXT] },
  { name: 'Images', extensions: [...IMAGE_EXT] },
  { name: 'All files', extensions: ['*'] },
];

// ---- images: convert unsupported formats to PNG, make small thumbnails (both cached)
let ffSlots = 2;
const ffWaiters = [];
async function withSlot(fn) {
  if (ffSlots === 0) await new Promise((r) => ffWaiters.push(r));
  ffSlots--;
  try { return await fn(); } finally { ffSlots++; const w = ffWaiters.shift(); if (w) w(); }
}
async function ffImage(file, prefix, ext, extra) {
  const out = path.join(cacheDir(), `${prefix}-${cacheKey(file)}.${ext}`);
  if (fs.existsSync(out)) return out;
  const tmp = out + '.part.' + ext;
  const { code } = await withSlot(() => runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', ...extra, tmp]));
  if (code !== 0 || !fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch {} return null; }
  fs.renameSync(tmp, out);
  return out;
}
ipcMain.handle('image-siblings', (_e, p) => imageSiblings(p));
ipcMain.handle('convert-image', async (_e, p) => {
  try { return (await ffImage(p, 'img', 'png', [])) || { error: 'ffmpeg could not decode this image' }; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('thumb', async (_e, p) => {
  try { return await ffImage(p, 'thumb', 'jpg', ['-vf', "scale='min(320,iw)':-2", '-q:v', '5']); } catch { return null; }
});
ipcMain.handle('file-stat', async (_e, p) => {
  try { const st = await fs.promises.stat(p); return { size: st.size, mtime: st.mtimeMs }; } catch { return null; }
});

ipcMain.handle('open-files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: MEDIA_FILTERS });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('open-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
  return r.canceled ? [] : expandPaths(r.filePaths);
});
ipcMain.handle('expand-paths', (_e, paths) => expandPaths(paths));
ipcMain.handle('open-subtitle', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('read-text', async (_e, p) => {
  try { return await fs.promises.readFile(p, 'utf8'); } catch { return null; }
});
ipcMain.handle('find-sidecar-subs', async (_e, media) => {
  const base = media.replace(/\.[^.\\/]+$/, '');
  for (const ext of ['.vtt', '.srt', '.en.srt', '.eng.srt']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return null;
});
ipcMain.handle('probe', async (_e, file) => {
  const info = await probe(file);
  if (!info.hasVideo && info.hasCover) info.cover = await extractCover(file);
  return info;
});
ipcMain.handle('transcode', async (e, file) => {
  try { return await transcode(file, e.sender); } catch (err) { return { error: err.message }; }
});
ipcMain.handle('cancel-transcode', () => { if (currentJob) { try { currentJob.kill(); } catch {} } });
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.on('save-settings', (_e, data) => {
  const cur = loadSettings();
  saveSettings({ ...data, window: cur.window });
});
ipcMain.handle('get-launch-files', () => { const f = launchFiles; launchFiles = []; return f; });
ipcMain.handle('save-screenshot', async (_e, dataUrl, name) => {
  const dir = path.join(app.getPath('pictures'), 'Prism Player');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name.replace(/[\\/:*?"<>|]/g, '_')}-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
});
ipcMain.handle('export-theme', async (_e, theme) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: `${theme.name || 'theme'}.prismtheme.json`, filters: [{ name: 'Prism theme', extensions: ['json'] }] });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, JSON.stringify(theme, null, 2));
  return true;
});
ipcMain.handle('import-theme', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Prism theme', extensions: ['json'] }] });
  if (r.canceled) return null;
  try { return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')); } catch { return null; }
});
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('open-cache', () => shell.openPath(cacheDir()));
ipcMain.handle('clear-cache', async () => {
  const d = cacheDir();
  let freed = 0;
  for (const f of await fs.promises.readdir(d)) {
    try { const p = path.join(d, f); freed += fs.statSync(p).size; fs.unlinkSync(p); } catch {}
  }
  return freed;
});
ipcMain.handle('ffmpeg-status', async () => {
  const { code, err } = await runFfmpeg(['-hide_banner', '-version']);
  return { ok: code === 0 || /ffmpeg version/.test(err), path: ffmpegPath() };
});
ipcMain.on('window', (_e, cmd, arg) => {
  if (!win) return;
  if (cmd === 'always-on-top') win.setAlwaysOnTop(!!arg);
  if (cmd === 'fullscreen') win.setFullScreen(!!arg);
  if (cmd === 'titlebar' && process.platform !== 'darwin') {
    try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: arg.symbol, height: 38 }); } catch {}
  }
  if (cmd === 'title') win.setTitle(arg);
  if (cmd === 'progress') win.setProgressBar(arg);
});
ipcMain.handle('is-fullscreen', () => (win ? win.isFullScreen() : false));

// ---------- app lifecycle ----------
if (!SMOKE && !app.requestSingleInstanceLock()) {
  dbg('single-instance lock held by another process, quitting');
  app.quit();
} else {
  app.on('second-instance', async (_e, argv) => {
    const files = await expandPaths(filesFromArgv(argv));
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (files.length) win.webContents.send('open-files', files);
    }
  });

  app.whenReady().then(async () => {
    launchFiles = await expandPaths(filesFromArgv(process.argv));
    registerProtocol();
    setupFeeds(() => win);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
