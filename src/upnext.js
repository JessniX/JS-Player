// Up next: near the end of an episode, the next one is lined up from the same add-on (same
// release group when the add-on says so, otherwise the same quality) and plays after a countdown.
'use strict';

const UPNEXT = { ctx: null, next: null, stream: null, fetching: false, shown: false, dismissed: false, timer: null, left: 0 };
const UPNEXT_SECS = 10;

// the episode after this one: specials (season 0) and episodes that aren't out yet are skipped
function nextEpisodeOf(meta, video) {
  if (!video || !Array.isArray(meta?.videos)) return null;
  const now = Date.now();
  const eps = meta.videos
    .filter((x) => x && x.id && (x.season ?? 1) > 0 && !(x.released && Date.parse(x.released) > now))
    .sort((a, b) => (a.season ?? 1) - (b.season ?? 1) || (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0));
  const i = eps.findIndex((x) => x.id === video.id);
  return i >= 0 ? eps[i + 1] || null : null;
}

// called when a Discover stream starts
function armUpNext(ctx) {
  hideUpNext();
  Object.assign(UPNEXT, { ctx: ctx.video ? ctx : null, next: null, stream: null, fetching: false, shown: false, dismissed: false });
}

function upNextPoint(d) { return Math.max(d - 30, d * 0.95); }

// from the player's timeupdate
function upNextTick() {
  const c = UPNEXT.ctx;
  if (!c) return;
  if (!current || current.item.path !== c.path) { hideUpNext(); return; }
  if (!S.stremio.autoNext || UPNEXT.dismissed) return;
  const d = mediaDuration(), t = mediaTime();
  if (!isFinite(d) || d < 30) return;
  const at = upNextPoint(d);
  if (!UPNEXT.fetching && t >= at - 90) prefetchUpNext();
  if (UPNEXT.shown && t < at - 2) { hideUpNext(); UPNEXT.shown = false; return; } // seeked back
  if (!UPNEXT.shown && UPNEXT.stream && t >= at && !(typeof sleepEndsHere === 'function' && sleepEndsHere())) showUpNext();
}

async function prefetchUpNext() {
  const c = UPNEXT.ctx;
  UPNEXT.fetching = true;
  const nv = nextEpisodeOf(c.meta, c.video);
  if (!nv || !c.addon) return;
  try {
    const data = await getJSON(resourceUrl(c.addon, 'stream', c.meta.type, nv.id), { ttl: 10 * 60 * 1000 });
    if (UPNEXT.ctx !== c) return;
    const streams = (data.streams || []).filter((s) => s && ['url', 'torrent'].includes(streamKind(s).k));
    const binge = c.s.behaviorHints?.bingeGroup;
    const q = streamInfo(c.s).quality, k = streamKind(c.s).k;
    const pick = (binge && streams.find((s) => s.behaviorHints?.bingeGroup === binge))
      || streams.find((s) => streamKind(s).k === k && streamInfo(s).quality === q)
      || streams.slice().sort((a, b) => streamScore({ kind: streamKind(b), info: streamInfo(b) }) - streamScore({ kind: streamKind(a), info: streamInfo(a) }))[0];
    if (pick) { UPNEXT.next = nv; UPNEXT.stream = pick; }
  } catch { /* no next episode lined up; the player just stops at the end */ }
}

function upNextEl() {
  let el = document.getElementById('upnext');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'upnext';
  el.className = 'upnext hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Up next');
  document.getElementById('busy').parentElement.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-un="play"]')) playUpNext();
    else if (e.target.closest('[data-un="cancel"]')) cancelUpNext();
  });
  return el;
}

function showUpNext() {
  const { ctx, next } = UPNEXT;
  const n = next.episode ?? next.number;
  const se = next.season != null && n != null ? `S${String(next.season).padStart(2, '0')}E${String(n).padStart(2, '0')}` : '';
  const thumb = safeHttp(next.thumbnail) || safeHttp(ctx.meta.background) || '';
  const el = upNextEl();
  el.innerHTML = `
    <div class="un-thumb" ${thumb ? `style="background-image:url(${escapeHtml(JSON.stringify(thumb))})"` : ''}>
      <svg class="un-ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="19" class="un-track"/><circle cx="22" cy="22" r="19" class="un-prog" style="animation-duration:${UPNEXT_SECS}s"/></svg>
      <span class="un-count" id="un-count">${UPNEXT_SECS}</span>
    </div>
    <div class="un-info">
      <div class="un-label">Up next</div>
      <div class="un-title">${escapeHtml([se, next.title || next.name].filter(Boolean).join(' · ') || 'Next episode')}</div>
      <div class="un-actions">
        <button class="btn primary small" data-un="play">${icon('play')} Play now</button>
        <button class="btn small" data-un="cancel">Cancel</button>
      </div>
    </div>`;
  el.classList.remove('hidden');
  UPNEXT.shown = true;
  UPNEXT.left = UPNEXT_SECS;
  clearInterval(UPNEXT.timer);
  UPNEXT.timer = setInterval(() => {
    const ring = el.querySelector('.un-prog');
    if (video.paused && !video.ended) { if (ring) ring.style.animationPlayState = 'paused'; return; }
    if (ring) ring.style.animationPlayState = 'running';
    UPNEXT.left--;
    const c = document.getElementById('un-count');
    if (c) c.textContent = Math.max(0, UPNEXT.left);
    if (UPNEXT.left <= 0) playUpNext();
  }, 1000);
}

function hideUpNext() {
  clearInterval(UPNEXT.timer);
  const el = document.getElementById('upnext');
  if (el) el.classList.add('hidden');
}
const upNextVisible = () => !!document.querySelector('#upnext:not(.hidden)');
function cancelUpNext() { UPNEXT.dismissed = true; hideUpNext(); osd('Up next cancelled'); }

function playUpNext() {
  const { ctx, next, stream } = UPNEXT;
  hideUpNext();
  if (!ctx || !next || !stream) return false;
  UPNEXT.ctx = null;
  playStream({ s: stream, meta: ctx.meta, video: next, addonObj: ctx.addon });
  return true;
}

// from the player's 'ended': true if the next episode took over
function upNextOnEnded() {
  if (!UPNEXT.ctx || !S.stremio.autoNext || UPNEXT.dismissed || !UPNEXT.stream) return false;
  if (!current || current.item.path !== UPNEXT.ctx.path) return false;
  return playUpNext();
}
