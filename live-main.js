// Live conversion for streams (torrents and web links), like Stremio's server does.
// Many streams use audio the built-in player can't decode (AC3, E-AC3, DTS, TrueHD) or containers
// like AVI. Instead of downloading the whole file first, ffmpeg converts it while you watch:
//   - video the player understands (H.264, VP9, AV1) is copied as-is (cheap)
//   - anything else is re-encoded to H.264 (uses more CPU)
//   - audio becomes stereo AAC
// Seeking restarts ffmpeg at the new position (prism://app/live?id=…&t=<seconds>).

const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const PLAYABLE_CONTAINER = /matroska|webm|mov,mp4|mp4|mp3|ogg|flac|wav/;
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
let subJob = null; // the one built-in subtitle track being read out

let ffmpegPath = () => 'ffmpeg';
let parseProbe = null;
const sessions = new Map(); // id -> { src, headers, v, a, proc }
let nextId = 1;

const headerArgs = (headers) => {
  const lines = Object.entries(headers || {}).filter(([k, v]) => /^[\w-]+$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return lines ? ['-headers', lines] : [];
};

function probeUrl(url, headers, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let err = '';
    let proc;
    try { proc = spawn(ffmpegPath(), ['-hide_banner', ...headerArgs(headers), '-i', url], { windowsHide: true }); } catch { return resolve(null); }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.stderr.on('data', (d) => { err += d; if (err.length > 200000) err = err.slice(-100000); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      const info = parseProbe(err);
      if (!info.ok) return resolve(null);
      info.format = (/Input #0, (.+?), from /.exec(err) || [])[1] || '';
      resolve(info);
    });
  });
}

// What the player should do with a stream: play it directly, or convert parts of it live.
function planFor(info) {
  const v = info.streams.find((s) => s.type === 'Video' && !s.attached);
  const a = info.streams.find((s) => s.type === 'Audio');
  const containerOk = PLAYABLE_CONTAINER.test(info.format);
  const videoOk = !v || PLAYABLE_VIDEO.has(v.codec) || v.codec === 'hevc'; // HEVC: try directly (many GPUs decode it), fall back to converting
  const audioOk = !a || PLAYABLE_AUDIO.has(a.codec);
  const plan = {
    duration: info.duration || 0, format: info.format, video: v ? v.codec : null, audio: a ? a.codec : null,
    width: v ? v.width : 0, height: v ? v.height : 0,
    // subtitles built into the video; text ones can be read out, picture ones (PGS/DVD) can't
    subs: info.streams.filter((s) => s.type === 'Subtitle').map((s) => ({ index: s.index, codec: s.codec, lang: s.lang || '', text: TEXT_SUBS.has(s.codec) })),
  };
  if (containerOk && videoOk && audioOk) return { ...plan, mode: 'direct' };
  return { ...plan, mode: 'live', v: v ? (PLAYABLE_VIDEO.has(v.codec) ? 'copy' : 'h264') : 'none', a: a ? 'aac' : 'none' };
}

function liveResponse(req, url) {
  const s = sessions.get(url.searchParams.get('id'));
  if (!s) return new Response('Not found', { status: 404 });
  if (s.proc) { try { s.proc.kill('SIGKILL'); } catch {} }
  const t = Math.max(0, parseFloat(url.searchParams.get('t')) || 0);
  const args = ['-hide_banner', '-loglevel', 'error', ...headerArgs(s.headers)];
  if (t > 0) args.push('-ss', t.toFixed(3));
  args.push('-i', s.src);
  if (s.v !== 'none') args.push('-map', '0:v:0');
  if (s.a !== 'none') args.push('-map', '0:a:0');
  if (s.v === 'copy') args.push('-c:v', 'copy');
  else if (s.v === 'h264') args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-g', '48');
  if (s.a === 'aac') args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k');
  args.push('-sn', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
  const proc = spawn(ffmpegPath(), args, { windowsHide: true });
  s.proc = proc;
  proc.stderr.on('data', (d) => { s.lastError = String(d).trim().split('\n').pop(); });
  proc.on('close', () => { if (s.proc === proc) s.proc = null; });
  const body = Readable.toWeb(proc.stdout);
  return new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } });
}

function setupLive(deps) {
  ffmpegPath = deps.ffmpegPath;
  parseProbe = deps.parseProbe;
  ipcMain.handle('stream-plan', async (_e, url, headers) => {
    if (!/^https?:\/\//i.test(url || '')) return { error: 'Unsupported link' };
    const info = await probeUrl(url, headers);
    if (!info) return { error: "Couldn't read this stream" };
    return planFor(info);
  });
  // forceVideo: convert the video too (when the player couldn't decode it, e.g. HEVC without hardware support)
  ipcMain.handle('live-create', (_e, { src, headers, v, a }) => {
    if (!/^https?:\/\//i.test(src || '')) return { error: 'Unsupported link' };
    for (const [id, s] of sessions) { if (s.proc) { try { s.proc.kill('SIGKILL'); } catch {} } sessions.delete(id); }
    const id = String(nextId++);
    sessions.set(id, { src, headers: headers || null, v: v || 'copy', a: a || 'aac', proc: null });
    return { id, url: `prism://app/live?id=${id}` };
  });
  // When video is copied, ffmpeg can only start at a keyframe at or before the seek point, so the
  // picture starts a little earlier than asked. Find that keyframe's real time so the clock matches.
  ipcMain.handle('live-keyframe', (_e, id, t) => new Promise((resolve) => {
    const s = sessions.get(id);
    if (!s || s.v !== 'copy' || !(t > 0)) return resolve(t);
    let out = '';
    let proc;
    try {
      proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...headerArgs(s.headers), '-ss', t.toFixed(3), '-i', s.src,
        '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-copyts', '-f', 'framemd5', '-'], { windowsHide: true });
    } catch { return resolve(t); }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 20000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(t); });
    proc.on('close', () => {
      clearTimeout(timer);
      const tb = /#tb 0: (\d+)\/(\d+)/.exec(out);
      const line = out.split(/\r?\n/).find((l) => /^\s*0,/.test(l));
      if (!tb || !line) return resolve(t);
      const pts = parseInt(line.split(',')[2], 10);
      const sec = (pts * +tb[1]) / +tb[2];
      resolve(isFinite(sec) && sec >= 0 && sec <= t + 0.5 ? sec : t);
    });
  }));
  // A subtitle file (SRT, ASS, VTT…), e.g. one inside a torrent: convert it to WebVTT text.
  ipcMain.handle('subs-convert', (_e, url, headers) => new Promise((resolve) => {
    if (!/^https?:\/\//i.test(url || '')) return resolve({ error: 'Unsupported link' });
    let out = '', err = '';
    let proc;
    try { proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...headerArgs(headers), '-i', url, '-f', 'webvtt', 'pipe:1'], { windowsHide: true }); } catch { return resolve({ error: 'ffmpeg not found' }); }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
    proc.stdout.on('data', (d) => { out += d; if (out.length > 5e6) { try { proc.kill(); } catch {} } });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', () => { clearTimeout(timer); resolve({ error: 'ffmpeg failed' }); });
    proc.on('close', () => { clearTimeout(timer); resolve(out ? { ok: true, text: out } : { error: err.trim().split('\n').pop() || 'No subtitles found' }); });
  }));
  // Subtitles built into the video: ffmpeg reads them out as the file arrives, and the cues are
  // sent to the window bit by bit (they're spread through the whole file).
  ipcMain.handle('subs-extract', (e, { url, headers, index }) => {
    if (!/^https?:\/\//i.test(url || '') || !Number.isInteger(index)) return { error: 'Unsupported' };
    if (subJob) { try { subJob.proc.kill('SIGKILL'); } catch {} }
    const id = String(Date.now());
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...headerArgs(headers), '-i', url, '-map', `0:${index}`, '-f', 'webvtt', 'pipe:1'], { windowsHide: true });
    subJob = { id, proc };
    const send = (msg) => { if (!e.sender.isDestroyed()) e.sender.send('subs-chunk', { id, ...msg }); };
    proc.stdout.on('data', (d) => send({ text: d.toString('utf8') }));
    proc.on('close', () => { if (subJob && subJob.id === id) subJob = null; send({ done: true }); });
    proc.on('error', () => send({ done: true, error: 'ffmpeg failed' }));
    return { id };
  });
  ipcMain.handle('subs-stop', () => { if (subJob) { try { subJob.proc.kill('SIGKILL'); } catch {} subJob = null; } return true; });
  ipcMain.handle('live-stop', () => {
    for (const [id, s] of sessions) { if (s.proc) { try { s.proc.kill('SIGKILL'); } catch {} } sessions.delete(id); }
    return true;
  });
}

function stopAllLive() {
  for (const s of sessions.values()) { if (s.proc) { try { s.proc.kill('SIGKILL'); } catch {} } }
  if (subJob) { try { subJob.proc.kill('SIGKILL'); } catch {} subJob = null; }
}

module.exports = { setupLive, liveResponse, stopAllLive };
