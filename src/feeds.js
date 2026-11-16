// Feeds: scroll your social feeds inside JS Player.
// Each site runs in its own sandboxed <webview>, all sharing one saved session (see feeds-main.js).

const FEEDS = [
  { id: 'youtube', name: 'YouTube Shorts', glyph: '▶', color: '#ff0033', desc: 'Short vertical videos from YouTube.', home: 'https://www.youtube.com/shorts', login: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fshorts', auto: true },
  { id: 'tiktok', name: 'TikTok', glyph: '♪', color: '#111111', ring: '#25f4ee', desc: 'Your For You page.', home: 'https://www.tiktok.com/foryou', login: 'https://www.tiktok.com/login', auto: true },
  { id: 'instagram', name: 'Instagram Reels', glyph: 'IG', color: '#d62976', desc: 'Reels from Instagram.', home: 'https://www.instagram.com/reels/', login: 'https://www.instagram.com/accounts/login/', auto: true },
  { id: 'facebook', name: 'Facebook Reels', glyph: 'f', color: '#1877f2', desc: 'Reels from Facebook.', home: 'https://www.facebook.com/reel/', login: 'https://www.facebook.com/login/', auto: true },
  { id: 'x', name: 'X', glyph: 'X', color: '#2a2a2a', desc: 'Your timeline.', home: 'https://x.com/home', login: 'https://x.com/i/flow/login', auto: false },
  { id: 'reddit', name: 'Reddit', glyph: 'r/', color: '#ff4500', desc: 'Your home feed.', home: 'https://www.reddit.com/', login: 'https://www.reddit.com/login/', auto: false },
];
const feedById = (id) => FEEDS.find((f) => f.id === id);

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

const PAUSE_JS = `document.querySelectorAll('video,audio').forEach(v => { if (!v.paused) { v.dataset.prismPaused = '1'; v.pause(); } }); 1`;
const RESUME_JS = `(() => { const v = [...document.querySelectorAll('video,audio')].find(x => x.dataset.prismPaused); document.querySelectorAll('[data-prism-paused]').forEach(x => delete x.dataset.prismPaused); if (v) v.play().catch(() => {}); return 1; })()`;

// ------------------------------------------------------------ mode switch
function setMode(mode) {
  if (mode === FD.mode) return;
  FD.mode = mode;
  S.mode = mode;
  document.body.classList.toggle('feeds-mode', mode === 'feeds');
  $('#feeds').classList.toggle('hidden', mode !== 'feeds');
  $$('.mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
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
  rail.innerHTML = `<button class="rail-btn home ${FD.onHome ? 'active' : ''}" data-home title="All feeds">${icon('grid')}</button><span class="rail-sep"></span>` +
    FEEDS.map((f) => `<button class="rail-btn ${!FD.onHome && FD.current === f.id ? 'active' : ''}" data-feed="${f.id}" title="${f.name}" style="--c:${f.color};${f.ring ? `box-shadow: inset 0 0 0 2px ${f.ring}` : ''}">${f.glyph}${FD.status[f.id] ? '<span class="on-dot" title="Signed in"></span>' : ''}</button>`).join('');
}
function renderFeedCards() {
  $('#feed-cards').innerHTML = FEEDS.map((f) => {
    const on = !!FD.status[f.id];
    return `<div class="feed-card" style="--c:${f.color === '#111111' || f.color === '#2a2a2a' ? (f.ring || '#888') : f.color}">
      <div class="fc-top"><div class="fc-icon" style="background:${f.color}">${f.glyph}</div>
        <div><h3>${f.name}</h3><span class="fc-status ${on ? 'on' : ''}">${on ? icon('check') + ' Signed in' : 'Not signed in'}</span></div></div>
      <p class="fc-desc">${f.desc}${f.auto ? '' : ' (Auto next isn\'t available here.)'}</p>
      <div class="fc-actions">
        <button class="btn primary" data-open="${f.id}">Open</button>
        <button class="btn" data-${on ? 'signout' : 'signin'}="${f.id}">${on ? 'Sign out' : 'Sign in'}</button>
      </div></div>`;
  }).join('');
}
$('#feed-rail').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-home')) showFeedHome();
  else openFeed(b.dataset.feed);
});
$('#feed-cards').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.open) openFeed(b.dataset.open);
  else if (b.dataset.signin) openFeed(b.dataset.signin, feedById(b.dataset.signin).login);
  else if (b.dataset.signout) signOutFeed(b.dataset.signout);
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
}

function updateFeedBar() {
  const f = feedById(FD.current);
  if (!f) return;
  const wv = FD.views.get(f.id);
  const on = !!FD.status[f.id];
  $('#feed-view').style.setProperty('--c', f.color === '#111111' ? f.ring : f.color);
  $('#fb-name').textContent = f.name;
  const st = $('#fb-status');
  st.textContent = on ? '· Signed in' : '· Not signed in';
  st.classList.toggle('on', on);
  $('#fb-sign').textContent = on ? 'Sign out' : 'Sign in';
  $('#fb-sign').classList.toggle('primary', !on);
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
  if (FD.status[f.id]) signOutFeed(f.id);
  else curView()?.loadURL(f.login);
};

async function signOutFeed(id) {
  const f = feedById(id);
  const extra = id === 'youtube' ? ' This also signs you out of Google inside JS Player.' : '';
  if (!confirm(`Sign out of ${f.name} in JS Player?${extra}`)) return;
  await api.feedsSignOut(id);
  await refreshFeedStatus();
  const wv = FD.views.get(id);
  if (wv) { try { wv.loadURL(f.home); } catch {} }
  osd(`Signed out of ${f.name}`);
}

function initFeeds() {
  renderFeedRail();
  renderFeedCards();
  syncAutoSwitches();
  if (S.mode === 'feeds') setMode('feeds');
}
