// Feeds: scroll your social feeds inside JS Player.
// Each site runs in its own sandboxed <webview>, all sharing one saved session (see feeds-main.js).

const BUILTIN_FEEDS = [
  { id: 'youtube', name: 'YouTube Shorts', glyph: '▶', color: '#ff0033', desc: 'Short vertical videos from YouTube.', home: 'https://www.youtube.com/shorts', login: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fshorts', auto: true },
  { id: 'tiktok', name: 'TikTok', glyph: '♪', color: '#111111', ring: '#25f4ee', desc: 'Your For You page.', home: 'https://www.tiktok.com/foryou', login: 'https://www.tiktok.com/login', auto: true },
  { id: 'instagram', name: 'Instagram Reels', glyph: 'IG', color: '#d62976', desc: 'Reels from Instagram.', home: 'https://www.instagram.com/reels/', login: 'https://www.instagram.com/accounts/login/', auto: true },
  { id: 'facebook', name: 'Facebook Reels', glyph: 'f', color: '#1877f2', desc: 'Reels from Facebook.', home: 'https://www.facebook.com/reel/', login: 'https://www.facebook.com/login/', auto: true },
  { id: 'x', name: 'X', glyph: 'X', color: '#2a2a2a', desc: 'Your timeline.', home: 'https://x.com/home', login: 'https://x.com/i/flow/login', auto: false },
  { id: 'reddit', name: 'Reddit', glyph: 'r/', color: '#ff4500', desc: 'Your home feed.', home: 'https://www.reddit.com/', login: 'https://www.reddit.com/login/', auto: false },
].map((f) => ({ ...f, builtin: true }));

// Your own sites live in S.feeds.custom; S.feeds.order and S.feeds.hidden control the list.
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : '#7c4dff');
function allFeeds() {
  const custom = (S.feeds.custom || []).map((c) => ({
    ...c, custom: true, color: safeColor(c.color), login: c.home, auto: !!c.auto, desc: c.desc || hostOf(c.home),
  }));
  const order = S.feeds.order || [];
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? 1000 : i; };
  return [...BUILTIN_FEEDS, ...custom].map((f, i) => ({ f, i })).sort((a, b) => rank(a.f.id) - rank(b.f.id) || a.i - b.i).map((x) => x.f);
}
const isHidden = (id) => (S.feeds.hidden || []).includes(id);
const visibleFeeds = () => allFeeds().filter((f) => !isHidden(f.id));
const feedById = (id) => allFeeds().find((f) => f.id === id);
// Icon HTML: your image, the built-in logo, or the emoji/text you typed.
function feedIcon(f) {
  if (f.icon && /^data:image\//.test(f.icon)) return `<img class="feed-img" src="${escapeHtml(f.icon)}" alt="">`;
  return brandIcon(f.id) || `<span class="feed-glyph">${escapeHtml(f.glyph || (f.name || '?').slice(0, 1).toUpperCase())}</span>`;
}
const accentOf = (f) => (f.color === '#111111' || f.color === '#2a2a2a' ? (f.ring || '#888') : f.color);

const FD = { mode: 'player', current: null, views: new Map(), status: {}, onHome: true };

// ------------------------------------------------------------ script injected into feed pages
// Watches the video you're looking at. When it reaches the end (or loops back to the start),
// it moves on: the site's own "next" button if there is one, else an ArrowDown key press
// sent by JS Player, else scrolling the feed by one screen.
function prismAutoNext(enabled) {
  if (window.__prismAuto) { window.__prismAuto.enabled = enabled; return 'updated'; }
  const st = (window.__prismAuto = { enabled, lastAdvance: 0 });
  const last = new WeakMap();
  const area = (el) => {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  };
  const mainVideo = () => {
    let best = null, ba = 0;
    for (const v of document.querySelectorAll('video')) {
      const a = area(v) * (v.paused ? 0.5 : 1);
      if (a > ba) { ba = a; best = v; }
    }
    return best;
  };
  const NEXT = ['#navigation-button-down button', 'button[aria-label="Next video"]', 'button[data-e2e="arrow-right"]', '[aria-label="Next Card"][role="button"]'];
  const usable = (el) => el && el.offsetParent !== null && area(el) > 0 && !el.disabled;
  function scrollFallback(v) {
    let el = v.parentElement;
    while (el && el !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 20) break;
      el = el.parentElement;
    }
    const target = el && el !== document.body ? el : document.scrollingElement;
    target.scrollBy({ top: target === document.scrollingElement ? innerHeight : target.clientHeight, behavior: 'smooth' });
  }
  function advance(v) {
    const now = Date.now();
    if (now - st.lastAdvance < 2000) return;
    st.lastAdvance = now;
    const before = { href: location.href, src: v.currentSrc };
    const btn = NEXT.map((s) => document.querySelector(s)).find(usable);
    if (btn) btn.click();
    else console.log('__PRISM_NEXT__');
    setTimeout(() => {
      if (location.href === before.href && mainVideo() === v && v.currentSrc === before.src) scrollFallback(v);
    }, 1200);
  }
  document.addEventListener('timeupdate', (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    const prev = last.get(v) ?? 0;
    last.set(v, v.currentTime);
    if (!st.enabled || !isFinite(v.duration) || v.duration < 2 || v !== mainVideo()) return;
    if (prev > v.duration - 1.2 && v.currentTime < 0.8) advance(v); // looped back to the start
  }, true);
  document.addEventListener('ended', (e) => {
    if (st.enabled && e.target instanceof HTMLVideoElement && e.target === mainVideo()) advance(e.target);
  }, true);
  return 'installed';
}

// YouTube only: keep the player at the chosen quality. 'auto' leaves it to YouTube, like Chrome.
function prismQuality(pref) {
  const prev = window.__prismQ;
  window.__prismQ = pref;
  const apply = () => {
    const q = window.__prismQ;
    for (const p of document.querySelectorAll('.html5-video-player')) {
      try {
        if (q === 'auto') { if (prev && prev !== 'auto') p.setPlaybackQualityRange?.('auto', 'auto'); continue; }
        const levels = (p.getAvailableQualityLevels?.() || []).filter((l) => l !== 'auto');
        if (!levels.length) continue;
        const want = q === 'hd'
          ? levels.find((l) => l === 'hd1080') || levels.find((l) => l === 'hd720') || levels[0]
          : levels.find((l) => l === 'medium') || levels[levels.length - 1];
        if (p.getPlaybackQuality?.() !== want) p.setPlaybackQualityRange?.(want, want);
      } catch { /* player not ready */ }
    }
  };
  apply();
  if (!window.__prismQTimer) window.__prismQTimer = setInterval(apply, 1500);
  return pref;
}

const PAUSE_JS = `document.querySelectorAll('video,audio').forEach(v => { if (!v.paused) { v.dataset.prismPaused = '1'; v.pause(); } }); 1`;
const RESUME_JS = `(() => { const v = [...document.querySelectorAll('video,audio')].find(x => x.dataset.prismPaused); document.querySelectorAll('[data-prism-paused]').forEach(x => delete x.dataset.prismPaused); if (v) v.play().catch(() => {}); return 1; })()`;

// ------------------------------------------------------------ mode switch
// Modes: 'player' (your files), 'feeds' (websites), 'discover' (Stremio add-ons)
function setMode(mode) {
  if (!['player', 'feeds', 'discover'].includes(mode)) mode = 'player';
  if (mode === FD.mode) return;
  // leaving the player while a stream is still loading cancels it (it would otherwise carry on unseen)
  if (FD.mode === 'player' && current?.remote && typeof busyShown === 'function' && busyShown()) {
    leaveStream();
    if (FD.mode === mode) return;
  }
  FD.mode = mode;
  S.mode = mode;
  document.body.classList.toggle('feeds-mode', mode === 'feeds');
  document.body.classList.toggle('discover-mode', mode === 'discover');
  $('#feeds').classList.toggle('hidden', mode !== 'feeds');
  $('#discover').classList.toggle('hidden', mode !== 'discover');
  $$('.mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  if (mode === 'discover') {
    if (fs) toggleFullscreen(false);
    openDiscover();
  }
  if (mode === 'feeds') {
    if (!video.paused) video.pause();
    if (IV.slideshow) toggleSlideshow(false, true);
    if (fs) toggleFullscreen(false);
    refreshFeedStatus();
    if (FD.current && !FD.onHome) openFeed(FD.current);
    else showFeedHome();
  } else {
    for (const wv of FD.views.values()) quietView(wv);
  }
  save();
}
$$('.mode-switch button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ------------------------------------------------------------ rendering
function renderFeedRail() {
  const rail = $('#feed-rail');
  rail.innerHTML = `<button class="rail-btn home ${FD.onHome ? 'active' : ''}" data-home title="All feeds" aria-label="All feeds">${icon('grid')}</button><span class="rail-sep"></span>` +
    visibleFeeds().map((f) => `<button class="rail-btn ${!FD.onHome && FD.current === f.id ? 'active' : ''} ${f.icon ? 'has-img' : ''}" data-feed="${f.id}" title="${escapeHtml(f.name)}" aria-label="${escapeHtml(f.name)}" style="--c:${f.color};${f.ring ? `box-shadow: inset 0 0 0 2px ${f.ring}` : ''}">${feedIcon(f)}${FD.status[f.id] ? '<span class="on-dot" title="Signed in"></span>' : ''}</button>`).join('') +
    `<button class="rail-btn add" data-add title="Add or customize feeds" aria-label="Add or customize feeds">${icon('plus')}</button>`;
}
function renderFeedCards() {
  $('#feed-cards').innerHTML = visibleFeeds().map((f) => {
    const on = !!FD.status[f.id];
    const status = f.custom ? escapeHtml(hostOf(f.home)) : on ? icon('check') + ' Signed in' : 'Not signed in';
    const second = f.custom
      ? `<button class="btn" data-edit="${f.id}">Edit</button>`
      : `<button class="btn" data-${on ? 'signout' : 'signin'}="${f.id}">${on ? 'Sign out' : 'Sign in'}</button>`;
    return `<div class="feed-card" style="--c:${accentOf(f)}">
      <div class="fc-top"><div class="fc-icon ${f.icon ? 'has-img' : ''}" style="background:${f.color}">${feedIcon(f)}</div>
        <div><h3>${escapeHtml(f.name)}</h3><span class="fc-status ${on && !f.custom ? 'on' : ''}">${status}</span></div></div>
      <p class="fc-desc">${escapeHtml(f.desc)}${f.auto ? '' : ' (Auto next isn\'t available here.)'}</p>
      <div class="fc-actions">
        <button class="btn" data-open="${f.id}">Open</button>
        ${second}
      </div></div>`;
  }).join('') + `<button class="feed-card add-card" data-cmd="customize-feeds"><span class="add-plus">${icon('plus')}</span><h3>Add a website</h3><p class="fc-desc">Any site you like, with your own icon.</p></button>`;
}
$('#feed-rail').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-home')) showFeedHome();
  else if (b.hasAttribute('data-add')) openFeedsDialog();
  else openFeed(b.dataset.feed);
});
$('#feed-cards').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.open) openFeed(b.dataset.open);
  else if (b.dataset.signin) openFeed(b.dataset.signin, feedById(b.dataset.signin).login);
  else if (b.dataset.signout) signOutFeed(b.dataset.signout);
  else if (b.dataset.edit) openFeedsDialog(b.dataset.edit);
});

let statusTimer;
async function refreshFeedStatus() {
  try { FD.status = await api.feedsStatus(); } catch { FD.status = {}; }
  renderFeedRail();
  renderFeedCards();
  updateFeedBar();
}
const refreshFeedStatusSoon = () => { clearTimeout(statusTimer); statusTimer = setTimeout(refreshFeedStatus, 1500); };

// ------------------------------------------------------------ showing feeds
function showFeedHome() {
  FD.onHome = true;
  $('#feed-home').classList.remove('hidden');
  $('#feed-view').classList.add('hidden');
  for (const wv of FD.views.values()) quietView(wv);
  syncAutoSwitches();
  renderFeedRail();
}

function openFeed(id, url) {
  const f = feedById(id);
  if (!f) return;
  if (FD.mode !== 'feeds') setMode('feeds');
  FD.current = id;
  FD.onHome = false;
  S.feeds.last = id;
  $('#feed-home').classList.add('hidden');
  $('#feed-view').classList.remove('hidden');
  $('#feed-error').classList.add('hidden');
  const wv = ensureView(f);
  for (const [vid, other] of FD.views) if (vid !== id) quietView(other);
  wv.classList.add('shown');
  try { wv.setAudioMuted(false); wv.executeJavaScript(RESUME_JS).catch(() => {}); } catch { /* not ready yet */ }
  if (url) wv.loadURL(url);
  $('#feed-ask').classList.toggle('hidden', !(f.auto && !S.feeds.askedAuto));
  renderFeedRail();
  updateFeedBar();
  save();
}

function quietView(wv) {
  wv.classList.remove('shown');
  try { wv.setAudioMuted(true); wv.executeJavaScript(PAUSE_JS).catch(() => {}); } catch { /* not ready yet */ }
}
const viewIsActive = (id) => FD.mode === 'feeds' && !FD.onHome && FD.current === id;

function ensureView(f) {
  let wv = FD.views.get(f.id);
  if (wv) return wv;
  wv = document.createElement('webview');
  wv.dataset.id = f.id;
  wv.setAttribute('partition', 'persist:feeds');
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes, sandbox=yes');
  wv.setAttribute('src', f.home);
  const progress = document.createElement('div');
  progress.className = 'feed-progress';

  wv.addEventListener('dom-ready', () => {
    injectAutoNext(wv, f);
    if (!viewIsActive(f.id)) quietView(wv);
    updateFeedBar();
  });
  wv.addEventListener('did-start-loading', () => { if (viewIsActive(f.id)) { progress.style.opacity = 1; progress.style.width = '70%'; } });
  wv.addEventListener('did-stop-loading', () => { progress.style.width = '100%'; setTimeout(() => { progress.style.opacity = 0; progress.style.width = '0'; }, 400); });
  const onNav = () => { updateFeedBar(); refreshFeedStatusSoon(); };
  wv.addEventListener('did-navigate', onNav);
  wv.addEventListener('did-navigate-in-page', onNav);
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3 = navigation replaced, not a real failure
    if (viewIsActive(f.id)) {
      $('#feed-error-text').textContent = `${f.name} didn't load (${e.errorDescription || 'error ' + e.errorCode}). Check your internet connection and try again.`;
      $('#feed-error').classList.remove('hidden');
    }
  });
  wv.addEventListener('media-started-playing', () => { if (!viewIsActive(f.id)) quietView(wv); });
  wv.addEventListener('console-message', (e) => {
    if (e.message === '__PRISM_NEXT__' && viewIsActive(f.id)) pressNext(wv);
  });
  $('#feed-frames').append(wv, progress);
  FD.views.set(f.id, wv);
  return wv;
}

function pressNext(wv) {
  wv.focus();
  wv.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  wv.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
}

function injectAutoNext(wv, f) {
  const on = !!(S.feeds.autoNext && f.auto);
  wv.executeJavaScript(`(${prismAutoNext.toString()})(${on})`).catch(() => {});
  if (f.id === 'youtube') wv.executeJavaScript(`(${prismQuality.toString()})(${JSON.stringify(S.feeds.quality)})`).catch(() => {});
}

function updateFeedBar() {
  const f = feedById(FD.current);
  if (!f) return;
  const wv = FD.views.get(f.id);
  const on = !!FD.status[f.id];
  $('#feed-view').style.setProperty('--c', accentOf(f));
  $('#fb-name').textContent = f.name;
  const st = $('#fb-status');
  st.textContent = f.custom ? '· ' + hostOf(f.home) : on ? '· Signed in' : '· Not signed in';
  st.classList.toggle('on', on && !f.custom);
  $('#fb-sign').textContent = f.custom ? 'Clear sign-in' : on ? 'Sign out' : 'Sign in';
  $('#fb-sign').classList.toggle('primary', !on && !f.custom);
  let back = false, fwd = false;
  try { back = wv.canGoBack(); fwd = wv.canGoForward(); } catch { /* not ready */ }
  $('#fb-back').disabled = !back;
  $('#fb-fwd').disabled = !fwd;
  const wrap = $('#fb-auto-wrap');
  wrap.classList.toggle('unsupported', !f.auto);
  wrap.title = f.auto ? 'Skip to the next video when one finishes' : `Auto next isn't available for ${f.name}`;
  syncAutoSwitches();
}

// ------------------------------------------------------------ auto next
function setAutoNext(on, quiet) {
  S.feeds.autoNext = on;
  S.feeds.askedAuto = true;
  $('#feed-ask').classList.add('hidden');
  syncAutoSwitches();
  for (const [id, wv] of FD.views) { try { injectAutoNext(wv, feedById(id)); } catch {} }
  if (!quiet) osd(on ? 'Auto next is on' : 'Auto next is off');
  save();
}
function syncAutoSwitches() {
  const f = feedById(FD.current);
  $('#fb-auto').checked = S.feeds.autoNext && (!f || f.auto);
  $('#feed-auto-home').checked = S.feeds.autoNext;
  $('#fb-auto-wrap').classList.toggle('on', $('#fb-auto').checked);
}
$('#fb-auto').addEventListener('change', (e) => setAutoNext(e.target.checked));
$('#feed-auto-home').addEventListener('change', (e) => setAutoNext(e.target.checked));
$('#ask-yes').onclick = () => setAutoNext(true);
$('#ask-no').onclick = () => { S.feeds.askedAuto = true; $('#feed-ask').classList.add('hidden'); osd('No problem. You can turn on Auto next any time'); save(); };

// ------------------------------------------------------------ toolbar
const curView = () => FD.views.get(FD.current);
$('#fb-home').onclick = showFeedHome;
$('#fb-back').onclick = () => { try { curView()?.goBack(); } catch {} };
$('#fb-fwd').onclick = () => { try { curView()?.goForward(); } catch {} };
$('#fb-reload').onclick = () => { $('#feed-error').classList.add('hidden'); try { curView()?.reload(); } catch {} };
$('#fb-top').onclick = () => { const f = feedById(FD.current); if (f) curView()?.loadURL(f.home); };
$('#feed-retry').onclick = () => { $('#feed-error').classList.add('hidden'); const f = feedById(FD.current); if (f) curView()?.loadURL(f.home); };
$('#fb-sign').onclick = () => {
  const f = feedById(FD.current);
  if (!f) return;
  if (f.custom || FD.status[f.id]) signOutFeed(f.id);
  else curView()?.loadURL(f.login);
};

async function signOutFeed(id) {
  const f = feedById(id);
  if (!f) return;
  const extra = id === 'youtube' ? ' This also signs you out of Google inside JS Player.' : '';
  if (f.custom) {
    if (!confirm(`Clear your sign-in and saved data for ${hostOf(f.home)} in JS Player?`)) return;
    await api.feedsClearSite(f.home);
  } else {
    if (!confirm(`Sign out of ${f.name} in JS Player?${extra}`)) return;
    await api.feedsSignOut(id);
  }
  await refreshFeedStatus();
  const wv = FD.views.get(id);
  if (wv) { try { wv.loadURL(f.home); } catch {} }
  osd(f.custom ? `Cleared ${hostOf(f.home)}` : `Signed out of ${f.name}`);
}

// Drop a site's open page (used when a custom site is removed or its address changes).
function closeFeedView(id) {
  const wv = FD.views.get(id);
  if (!wv) return;
  const bar = wv.nextElementSibling;
  if (bar && bar.classList.contains('feed-progress')) bar.remove();
  wv.remove();
  FD.views.delete(id);
  if (FD.current === id) { FD.current = null; if (FD.mode === 'feeds') showFeedHome(); }
}

// ------------------------------------------------------------ speed & quality options
function setFeedQuality(q) {
  S.feeds.quality = q;
  $('#feed-quality').value = q;
  const wv = FD.views.get('youtube');
  if (wv) { try { injectAutoNext(wv, feedById('youtube')); } catch {} }
  osd({ auto: 'YouTube quality: Auto', hd: 'YouTube quality: prefer HD', saver: 'YouTube quality: data saver' }[q]);
  save();
}
$('#feed-quality').addEventListener('change', (e) => setFeedQuality(e.target.value));

// full-screen feed: hide every JS Player bar so the video gets the whole window
let feedFull = false;
function toggleFeedFull(force) {
  feedFull = force ?? !feedFull;
  document.body.classList.toggle('feed-full', feedFull);
  api.windowCmd('fullscreen', feedFull || (typeof TV !== 'undefined' && TV.on));
  if (feedFull) osd('Press Esc or the button at the top to leave full screen', 2200);
  curView()?.focus();
}
$('#fb-full').onclick = () => toggleFeedFull(true);
$('#feed-exit-full').onclick = () => toggleFeedFull(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && feedFull) toggleFeedFull(false); });
api.onFeedEscape(() => { if (feedFull) toggleFeedFull(false); });

function initFeeds() {
  renderFeedRail();
  renderFeedCards();
  syncAutoSwitches();
  $('#feed-quality').value = S.feeds.quality;
  if (S.mode === 'feeds') setMode('feeds');
}
