// Stremio account sync: your add-ons, library and Continue Watching, plus watch progress.
// The account requests run in the main process (stremio-main.js), which keeps the sign-in key.

const ACC = { signedIn: false, email: '', library: [] };

// ------------------------------------------------------------ account state
async function refreshAccount() {
  try { const a = await api.stremioAccount(); ACC.signedIn = !!a.signedIn; ACC.email = a.email || ''; } catch { ACC.signedIn = false; }
  renderAccount();
}
function handleAcctResult(r) {
  if (r && r.signedOut) { ACC.signedIn = false; ACC.library = []; renderAccount(); osd(r.error, 3000); }
  return r;
}
function acctMsg(text, kind) {
  const m = $('#acct-msg');
  if (!m) return;
  m.textContent = text || '';
  m.style.color = kind === 'bad' ? '#ff6b6b' : kind === 'good' ? '#3ddc84' : 'var(--dim)';
}

// ------------------------------------------------------------ add-ons
async function syncAddonsFromAccount() {
  const r = handleAcctResult(await api.stremioAddonsGet());
  if (!r.ok) { acctMsg(`Couldn't get your add-ons: ${r.error}`, 'bad'); return false; }
  const before = new Map((S.stremio.addons || []).map((a) => [a.transportUrl, a.enabled]));
  S.stremio.addons = (r.data || []).filter((a) => a && a.transportUrl && a.manifest)
    .map((a) => ({ transportUrl: a.transportUrl, manifest: a.manifest, flags: a.flags || {}, enabled: before.get(a.transportUrl) ?? true }));
  S.stremio.defaultsInstalled = true;
  save();
  DC.cache.clear();
  return true;
}
let addonPushTimer = null;
function pushAddonsSoon() {
  if (!ACC.signedIn || !S.stremio.syncAddons) return;
  clearTimeout(addonPushTimer);
  addonPushTimer = setTimeout(async () => {
    const addons = S.stremio.addons.map((a) => ({ transportUrl: a.transportUrl, manifest: a.manifest, flags: a.flags || { official: false, protected: false } }));
    const r = handleAcctResult(await api.stremioAddonsSet(addons));
    if (!r.ok) osd(`Couldn't save add-ons to Stremio: ${r.error}`, 3000);
  }, 800);
}

// ------------------------------------------------------------ library
async function loadLibrary() {
  if (!ACC.signedIn || !S.stremio.syncLibrary) { ACC.library = []; return; }
  const r = handleAcctResult(await api.stremioLibraryGet());
  ACC.library = r.ok && Array.isArray(r.data) ? r.data.filter((x) => x && x._id && x.type) : [];
}
const when = (x) => new Date(x || 0).getTime() || 0;
function libraryRowsHtml(type) {
  if (!ACC.signedIn || !S.stremio.syncLibrary || !ACC.library.length) return '';
  const items = ACC.library.filter((x) => x.type === type);
  const progressOf = (x) => (x.state && x.state.duration ? x.state.timeOffset / x.state.duration : 0);
  const cw = items.filter((x) => (!x.removed || x.temp) && x.state && x.state.timeOffset > 0)
    .sort((a, b) => when(b.state.lastWatched) - when(a.state.lastWatched)).slice(0, 30);
  const lib = items.filter((x) => !x.removed && !x.temp).sort((a, b) => when(b._mtime) - when(a._mtime)).slice(0, 60);
  const card = (x) => posterCard({
    id: x._id, type: x.type, name: x.name, poster: x.poster, posterShape: x.posterShape,
    resumeVideoId: (x.state && x.state.video_id) || null, progress: progressOf(x),
  });
  const row = (title, list) => (list.length ? `<section class="dc-row lib"><div class="dc-row-head"><h3>${title} <span class="dim">· your Stremio</span></h3></div>
    <div class="dc-row-items">${list.map(card).join('')}</div></section>` : '');
  return row('Continue watching', cw) + row('Your library', lib);
}
// where to resume a title, from your Stremio progress (seconds)
function libraryResumeFor(meta, video) {
  const li = ACC.library.find((x) => x._id === meta.id);
  if (!li || !li.state || !(li.state.timeOffset > 0)) return 0;
  const vid = video ? video.id : meta.id;
  if (li.state.video_id && li.state.video_id !== vid) return 0;
  return li.state.timeOffset / 1000;
}

// ------------------------------------------------------------ saving watch progress
// Stremio stores times in milliseconds and dates as ISO strings.
let lastTick = 0;
let progressBusy = false;
async function pushProgress(final) {
  const it = current && current.item;
  if (!it || !it.stremio || !ACC.signedIn || !S.stremio.syncLibrary || progressBusy) return;
  const t = mediaTime(), d = mediaDuration();
  if (!isFinite(d) || d < 60 || t < 5) return;
  const now = new Date();
  const iso = now.toISOString();
  const elapsed = lastTick ? Math.min(70000, now.getTime() - lastTick) : 0;
  lastTick = video.paused ? 0 : now.getTime();
  const sm = it.stremio;
  let li = ACC.library.find((x) => x._id === sm.metaId);
  if (!li) {
    // watched without adding to the library: Stremio keeps these as "temp" items (they show in Continue Watching)
    li = {
      _id: sm.metaId, name: sm.name || it.title, type: sm.type, poster: sm.poster || '', posterShape: 'poster',
      removed: true, temp: true, _ctime: iso, _mtime: iso,
      state: { lastWatched: iso, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false },
      behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
    };
    ACC.library.push(li);
  }
  const st = li.state || (li.state = {});
  const done = final === 'ended' || t / d > 0.9;
  st.timeOffset = done ? 0 : Math.round(t * 1000);
  st.duration = Math.round(d * 1000);
  st.video_id = sm.id;
  st.lastWatched = iso;
  st.timeWatched = (st.timeWatched || 0) + elapsed;
  st.overallTimeWatched = (st.overallTimeWatched || 0) + elapsed;
  if (done) { st.timesWatched = (st.timesWatched || 0) + 1; st.flaggedWatched = 1; }
  li._mtime = iso;
  progressBusy = true;
  try {
    const r = handleAcctResult(await api.stremioLibraryPut([li]));
    if (!r.ok) console.warn('Stremio progress not saved:', r.error);
  } finally { progressBusy = false; }
}
setInterval(() => { if (current?.item?.stremio && !video.paused) pushProgress(); }, 60000);
video.addEventListener('play', () => { lastTick = Date.now(); });
video.addEventListener('pause', () => pushProgress());
video.addEventListener('ended', () => pushProgress('ended'));
window.addEventListener('beforeunload', () => pushProgress());

// ------------------------------------------------------------ Settings → Stremio account
function renderAccount() {
  const box = $('#acct');
  if (!box) return;
  if (!ACC.signedIn) {
    box.innerHTML = `<p class="dim small">Sign in to use your Stremio add-ons, library and Continue Watching here, and to save what you watch back to Stremio.</p>
      <form id="acct-form" class="acct-form" autocomplete="on">
        <input class="input" id="acct-email" type="email" placeholder="Stremio email" autocomplete="username">
        <input class="input" id="acct-pass" type="password" placeholder="Password" autocomplete="current-password">
        <button class="btn small primary" type="submit">Sign in to Stremio</button>
      </form>
      <p class="dim small">Your password goes only to Stremio and isn't saved. JS Player keeps an encrypted sign-in key on this PC.</p>
      <p id="acct-msg" class="small"></p>`;
    $('#acct-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#acct-email').value.trim(), pass = $('#acct-pass');
      acctMsg('Signing in…');
      const r = await api.stremioLogin(email, pass.value);
      pass.value = '';
      if (!r.ok) return acctMsg(r.error, 'bad');
      ACC.signedIn = true;
      ACC.email = r.email;
      renderAccount();
      await syncNow(true);
    });
    return;
  }
  box.innerHTML = `<p class="small">Signed in as <b>${escapeHtml(ACC.email)}</b></p>
    <label class="check"><input type="checkbox" id="acct-sync-addons" ${S.stremio.syncAddons ? 'checked' : ''}> Use my Stremio add-ons (changes sync both ways)</label>
    <label class="check"><input type="checkbox" id="acct-sync-lib" ${S.stremio.syncLibrary ? 'checked' : ''}> Show my library and save watch progress to Stremio</label>
    <div class="row gap"><button class="btn small" id="acct-sync-now">Sync now</button><button class="btn small" id="acct-signout">Sign out</button></div>
    <p id="acct-msg" class="small"></p>`;
  $('#acct-sync-addons').addEventListener('change', (e) => { S.stremio.syncAddons = e.target.checked; save(); if (e.target.checked) syncNow(); });
  $('#acct-sync-lib').addEventListener('change', (e) => { S.stremio.syncLibrary = e.target.checked; save(); syncNow(); });
  $('#acct-sync-now').onclick = () => syncNow();
  $('#acct-signout').onclick = async () => {
    if (!confirm('Sign out of Stremio in JS Player? Your add-ons stay here; your library rows go away.')) return;
    await api.stremioLogout();
    ACC.signedIn = false;
    ACC.library = [];
    renderAccount();
    if (typeof refreshDiscover === 'function' && FD.mode === 'discover') refreshDiscover();
    osd('Signed out of Stremio');
  };
}
async function syncNow(first) {
  acctMsg('Syncing…');
  let addonsOk = true;
  if (S.stremio.syncAddons) addonsOk = await syncAddonsFromAccount();
  await loadLibrary();
  if (!ACC.signedIn) return;
  const n = (S.stremio.addons || []).length;
  acctMsg(`${first ? 'Signed in. ' : ''}${S.stremio.syncAddons && addonsOk ? `${n} add-on${n === 1 ? '' : 's'}` : 'Add-ons not synced'}${S.stremio.syncLibrary ? ` · ${ACC.library.filter((x) => !x.removed && !x.temp).length} in your library` : ''}.`, 'good');
  if (typeof refreshDiscover === 'function') { DC.started = true; refreshDiscover(); }
}
function initAccountUi() { refreshAccount(); }
