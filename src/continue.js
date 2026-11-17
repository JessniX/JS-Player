// Continue watching, kept on this computer (no Stremio account needed).
// - While a Discover title plays, where you are is saved: one entry per movie or show, newest first.
// - The Discover home shows a "Continue watching" row. Clicking a card plays the same stream again
//   from where you stopped. A finished episode is replaced by the next one.
// - Picking any stream for an episode you started resumes it too.
// Rules: under 30 seconds isn't worth resuming; 90% or more counts as watched.
'use strict';

const CW_MAX = 100;
const CW_MIN_SECS = 30;
const CW_DONE = 0.9;

const cwList = () => (Array.isArray(S.watchHistory) ? S.watchHistory : (S.watchHistory = []));

// save where you are in the Discover title that's playing (final: it just ended)
function recordWatch(final) {
  const it = current && current.item;
  const sm = it && it.stremio;
  if (!sm || !it.cw) return;
  const t = mediaTime(), d = mediaDuration();
  if (!isFinite(d) || d < 60 || (t < CW_MIN_SECS && final !== 'ended')) return;
  const done = final === 'ended' || t / d >= CW_DONE;
  const list = cwList();
  const i = list.findIndex((x) => x.id === sm.metaId);
  if (i >= 0) list.splice(i, 1);
  list.unshift({
    id: sm.metaId, type: sm.type, name: sm.name || it.title, poster: sm.poster, background: sm.background, logo: sm.logo,
    videoId: sm.id, ep: it.cw.ep || null, t: Math.floor(t), d: Math.floor(d), at: Date.now(), done,
    s: it.cw.s, addonUrl: it.cw.addonUrl, next: it.cw.next || null,
  });
  if (list.length > CW_MAX) list.length = CW_MAX;
  save();
}
setInterval(() => { if (current?.item?.cw && !video.paused) recordWatch(); }, 10000);
video.addEventListener('pause', () => recordWatch());
video.addEventListener('ended', () => recordWatch('ended'));
window.addEventListener('beforeunload', () => recordWatch());

// where to start an episode or movie you've watched part of (seconds, 0 = from the start)
function resumeFor(meta, video) {
  const e = cwList().find((x) => x.id === meta.id);
  const vid = video ? video.id : meta.id;
  return e && !e.done && e.videoId === vid && e.t >= CW_MIN_SECS ? e.t : 0;
}

// "S01E03" for an episode-like object
const cwSE = (v) => (v && v.season != null && (v.episode ?? v.number) != null ? `S${String(v.season).padStart(2, '0')}E${String(v.episode ?? v.number).padStart(2, '0')}` : '');

// the Discover row: unfinished titles, and shows whose next episode is waiting
function continueRowHtml(type) {
  const items = cwList().filter((x) => x.type === type && ((!x.done && x.t >= CW_MIN_SECS) || (x.done && x.next))).slice(0, 20);
  if (!items.length) return '';
  const cards = items.map((x) => posterCard({
    id: x.id, type: x.type, name: x.name, poster: x.poster, background: x.background, logo: x.logo,
    releaseInfo: x.done ? `▶ ${cwSE(x.next)}` : cwSE(x.ep), progress: x.done ? 0 : x.t / x.d, cwId: x.id,
  })).join('');
  return `<section class="dc-row lib"><div class="dc-row-head"><h3>Continue watching</h3></div><div class="dc-row-items">${cards}</div></section>`;
}

// a card in the row was clicked
async function resumeFromHistory(id) {
  const e = cwList().find((x) => x.id === id);
  if (!e) return;
  // finished: open the next episode so you can pick a stream for it
  if (e.done) return go({ kind: 'detail', meta: { id: e.id, type: e.type, name: e.name, poster: e.poster, resumeVideoId: e.next && e.next.id } });
  // open the episode first, so if the stream won't start you land on its other streams
  go({ kind: 'detail', meta: { id: e.id, type: e.type, name: e.name, poster: e.poster, resumeVideoId: e.videoId !== e.id ? e.videoId : null } });
  if (!e.s) return;
  const meta = (await fetchMeta(e.type, e.id).catch(() => null)) || { id: e.id, type: e.type, name: e.name, poster: e.poster, background: e.background, logo: e.logo };
  const video = e.videoId !== e.id ? ((meta.videos || []).find((v) => v.id === e.videoId) || { id: e.videoId, ...(e.ep || {}) }) : null;
  const addonObj = enabledAddons().find((a) => a.transportUrl === e.addonUrl) || null;
  playStream({ s: e.s, meta, video, addonObj });
}
