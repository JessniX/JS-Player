// Discover: browse and play from Stremio add-ons.
//
// Stremio add-ons speak a small open HTTP protocol:
//   <base>/manifest.json                       what the add-on offers
//   <base>/catalog/<type>/<id>[/<extra>].json   lists (popular, search results, …)
//   <base>/meta/<type>/<id>.json                details, seasons and episodes
//   <base>/stream/<type>/<videoId>.json         playable streams
//   <base>/subtitles/<type>/<videoId>.json      subtitles
// Installed add-ons live in S.stremio.addons as { transportUrl, manifest, enabled }.

const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json', // official: movie and series catalogs and details
  'https://opensubtitles-v3.strem.io/manifest.json', // official: subtitles
];
const TYPE_NAMES = { movie: 'Movies', series: 'Series', channel: 'Channels', tv: 'TV' };
const TYPE_ORDER = ['movie', 'series', 'channel', 'tv'];
const DC = { started: false, view: null, stack: [], cache: new Map(), reg: new Map(), regN: 0, searchTimer: null, token: 0 };
const addonsDlg = $('#addons-dialog');
hydrateIcons(addonsDlg);

// ------------------------------------------------------------ add-on protocol helpers
function normalizeAddonUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return null;
  if (/^stremio:\/\//i.test(u)) u = 'https://' + u.slice('stremio://'.length);
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { new URL(u); } catch { return null; }
  if (!/\/manifest\.json(\?.*)?$/i.test(u)) u = u.replace(/\/+$/, '') + '/manifest.json';
  return u;
}
const baseOf = (transportUrl) => transportUrl.replace(/\/manifest\.json(\?.*)?$/i, '');
const enabledAddons = () => (S.stremio.addons || []).filter((a) => a.enabled !== false && a.manifest);
const safeHttp = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '');

async function getJSON(url, { ttl = 10 * 60 * 1000 } = {}) {
  const hit = DC.cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  const r = await api.addonFetch(url);
  if (!r.ok) throw new Error(r.error || 'Request failed');
  DC.cache.set(url, { t: Date.now(), data: r.data });
  return r.data;
}

// Does an add-on offer this resource for this type (and id)?
function supports(addon, resource, type, id) {
  const m = addon.manifest;
  for (const r of m.resources || []) {
    const name = typeof r === 'string' ? r : r.name;
    if (name !== resource) continue;
    const types = typeof r === 'string' ? m.types : r.types || m.types;
    const prefixes = typeof r === 'string' ? m.idPrefixes : r.idPrefixes ?? m.idPrefixes;
    if (types && type && !types.includes(type)) continue;
    if (id && Array.isArray(prefixes) && prefixes.length && !prefixes.some((p) => id.startsWith(p))) continue;
    return true;
  }
  return false;
}
// catalogs can describe their options in two formats
function catalogExtras(cat) {
  if (Array.isArray(cat.extra)) return cat.extra;
  const req = cat.extraRequired || [];
  return (cat.extraSupported || []).map((name) => ({ name, isRequired: req.includes(name) }));
}
const hasExtra = (cat, name) => catalogExtras(cat).some((e) => e.name === name);
const needsExtra = (cat) => catalogExtras(cat).some((e) => e.isRequired);
function catalogUrl(addon, cat, extra = {}) {
  const args = Object.entries(extra).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${baseOf(addon.transportUrl)}/catalog/${encodeURIComponent(cat.type)}/${encodeURIComponent(cat.id)}${args ? '/' + args : ''}.json`;
}
const resourceUrl = (addon, res, type, id) => `${baseOf(addon.transportUrl)}/${res}/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;

function allCatalogs() {
  const out = [];
  for (const addon of enabledAddons()) {
    if (!supports(addon, 'catalog')) continue;
    for (const cat of addon.manifest.catalogs || []) out.push({ addon, cat });
  }
  return out;
}
function availableTypes() {
  const set = new Set(allCatalogs().filter(({ cat }) => !needsExtra(cat) || hasExtra(cat, 'search')).map(({ cat }) => cat.type));
  return [...set].sort((a, b) => ((TYPE_ORDER.indexOf(a) + 99) % 99) - ((TYPE_ORDER.indexOf(b) + 99) % 99));
}

// ------------------------------------------------------------ install / manage add-ons
async function fetchManifest(url) {
  const m = await getJSON(url, { ttl: 0 });
  if (!m || typeof m !== 'object' || !m.id || !m.name || !Array.isArray(m.resources)) throw new Error("That link isn't a Stremio add-on manifest.");
  return m;
}
async function installAddon(raw) {
  const url = normalizeAddonUrl(raw);
  if (!url) throw new Error("That doesn't look like an add-on link.");
  const manifest = await fetchManifest(url);
  const list = S.stremio.addons;
  const same = list.find((a) => a.transportUrl === url) || list.find((a) => a.manifest?.id === manifest.id);
  if (same) { same.transportUrl = url; same.manifest = manifest; same.enabled = true; }
  else list.push({ transportUrl: url, manifest, enabled: true });
  save();
  if (typeof pushAddonsSoon === 'function') pushAddonsSoon();
  return { manifest, updated: !!same };
}
let addonsReady = null;
function ensureAddons() {
  if (addonsReady) return addonsReady;
  addonsReady = (async () => {
    await refreshAccount();
    if (ACC.signedIn && S.stremio.syncAddons) {
      // signed in to Stremio: use the add-ons from the account
      await syncAddonsFromAccount();
      await loadLibrary();
      return;
    }
    await loadLibrary();
    if (!S.stremio.defaultsInstalled) {
      for (const u of DEFAULT_ADDONS) { try { await installAddon(u); } catch { /* offline: try next time */ } }
      if (S.stremio.addons.length) { S.stremio.defaultsInstalled = true; save(); }
    } else {
      // refresh manifests quietly so catalogs stay current
      Promise.all(S.stremio.addons.map(async (a) => { try { a.manifest = await fetchManifest(a.transportUrl); } catch {} })).then(() => save());
    }
  })();
  return addonsReady;
}

function renderAddonsList() {
  const list = S.stremio.addons || [];
  $('#ad-list').innerHTML = list.length ? list.map((a, i) => {
    const m = a.manifest || {};
    const res = (m.resources || []).map((r) => (typeof r === 'string' ? r : r.name));
    const what = [res.includes('catalog') && 'catalogs', res.includes('meta') && 'details', res.includes('stream') && 'streams', res.includes('subtitles') && 'subtitles'].filter(Boolean).join(', ');
    const logo = safeHttp(m.logo);
    return `<li class="${a.enabled === false ? 'is-off' : ''}" data-i="${i}">
      <div class="ad-logo">${logo ? `<img src="${escapeHtml(logo)}" alt="">` : icon('puzzle')}</div>
      <div class="ad-text"><b>${escapeHtml(m.name || 'Add-on')}</b> <span class="dim small">v${escapeHtml(m.version || '?')}</span>
        <span class="ad-desc">${escapeHtml(m.description || '')}</span>
        <span class="dim small">${escapeHtml((m.types || []).map((t) => TYPE_NAMES[t] || t).join(', '))}${what ? ' · ' + escapeHtml(what) : ''}</span></div>
      <div class="ad-actions">
        <label class="switch" title="${a.enabled === false ? 'Turn on' : 'Turn off'}"><input type="checkbox" data-act="toggle" ${a.enabled === false ? '' : 'checked'} aria-label="${escapeHtml(m.name || 'Add-on')} on/off"><span></span></label>
        ${m.behaviorHints?.configurable ? `<button class="btn small" data-act="configure">Configure</button>` : ''}
        <button class="icon-btn" data-act="up" title="Move up (asked first)" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
        <button class="icon-btn" data-act="down" title="Move down" aria-label="Move down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
        <button class="icon-btn" data-act="remove" title="Remove" aria-label="Remove ${escapeHtml(m.name || 'add-on')}">${icon('trash')}</button>
      </div></li>`;
  }).join('') : '<li class="dim">No add-ons yet. Paste an add-on link above.</li>';
}
function openAddonsDialog() {
  renderAddonsList();
  $('#ad-msg').textContent = '';
  if (!addonsDlg.open) addonsDlg.showModal();
}
COMMANDS['manage-addons'] = openAddonsDialog;
closeOnBackdrop(addonsDlg);
addonsDlg.addEventListener('close', () => { if (FD.mode === 'discover') refreshDiscover(); });

$('#ad-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#ad-msg');
  const raw = $('#ad-url').value;
  msg.style.color = 'var(--dim)';
  msg.textContent = 'Checking the add-on…';
  try {
    const { manifest, updated } = await installAddon(raw);
    msg.style.color = '#3ddc84';
    msg.textContent = `${updated ? 'Updated' : 'Installed'} ${manifest.name}${manifest.behaviorHints?.configurationRequired ? '. It needs setting up first: use Configure.' : '.'}`;
    $('#ad-url').value = '';
    renderAddonsList();
  } catch (err) {
    msg.style.color = '#ff6b6b';
    msg.textContent = `Couldn't install it: ${err.message}`;
  }
});
$('#ad-list').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const i = +el.closest('li').dataset.i;
  const list = S.stremio.addons;
  const a = list[i];
  const act = el.dataset.act;
  if (act === 'toggle') { a.enabled = el.checked; }
  else if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
  else if (act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
  else if (act === 'configure') { window.open(baseOf(a.transportUrl) + '/configure'); return; }
  else if (act === 'remove') {
    if (!confirm(`Remove ${a.manifest?.name || 'this add-on'}?`)) return;
    list.splice(i, 1);
  } else return;
  DC.cache.clear();
  save();
  renderAddonsList();
  if (act !== 'toggle') pushAddonsSoon(); // on/off is local to JS Player; Stremio has no such switch
});

// ------------------------------------------------------------ Discover views
const dcBody = () => $('#dc-body');
function reg(meta) { const k = 'm' + ++DC.regN; DC.reg.set(k, meta); return k; }
function posterCard(meta) {
  const poster = safeHttp(meta.poster);
  const shape = meta.posterShape === 'landscape' ? 'landscape' : meta.posterShape === 'square' ? 'square' : 'poster';
  const rating = parseFloat(meta.imdbRating);
  const year = String(meta.releaseInfo || meta.year || '').slice(0, 9);
  const badges = [rating > 0 ? `<span class="b-rate">★ ${rating.toFixed(1)}</span>` : '', year ? `<span>${escapeHtml(year)}</span>` : ''].join('');
  return `<button class="dc-card ${shape}" data-k="${reg(meta)}" title="${escapeHtml(meta.name || '')}">
    ${poster ? `<img loading="lazy" src="${escapeHtml(poster)}" alt="" data-fallback="remove">` : ''}
    ${badges ? `<span class="dc-card-badges">${badges}</span>` : ''}
    <span class="dc-card-name">${escapeHtml(meta.name || '')}</span>
    ${meta.progress > 0 ? `<span class="dc-progress"><span style="width:${Math.min(100, Math.round(meta.progress * 100))}%"></span></span>` : ''}</button>`;
}

// friendlier row titles for the usual catalog names
const ROW_TITLES = { popular: '🔥 Popular right now', top: '🔥 Popular right now', new: '✨ New & noteworthy', year: '✨ New this year', featured: '⭐ Featured picks', imdbrating: '🏆 Top rated', trending: '📈 Trending', 'last-videos': '🆕 Latest episodes', calendar: '📅 Coming up' };
const rowTitle = (cat) => ROW_TITLES[String(cat.name || cat.id).toLowerCase()] || ROW_TITLES[String(cat.id).toLowerCase()] || cat.name || cat.id;
const GENRE_EMOJI = { action: '💥', adventure: '🧭', animation: '🎨', anime: '🌸', biography: '📖', comedy: '😂', crime: '🕵️', documentary: '🎥', drama: '🎭', family: '👨‍👩‍👧',
  fantasy: '🧙', 'film-noir': '🎩', 'game-show': '🎲', history: '📜', horror: '👻', music: '🎵', musical: '🎶', mystery: '🔍', news: '📰', 'reality-tv': '📺', romance: '💕',
  'sci-fi': '🚀', 'science fiction': '🚀', short: '⏱️', sport: '⚽', 'talk-show': '🎤', thriller: '😱', war: '⚔️', western: '🤠' };
const genreLabel = (g) => `${GENRE_EMOJI[String(g).toLowerCase()] || '🎬'} ${g}`;
const skeletons = (n = 8) => Array.from({ length: n }, () => '<span class="dc-card poster skeleton"></span>').join('');

function renderTypes() {
  const types = availableTypes();
  if (!types.includes(S.stremio.type)) S.stremio.type = types[0] || 'movie';
  $('#dc-types').innerHTML = types.map((t) => `<button class="dc-type ${t === S.stremio.type ? 'active' : ''}" data-type="${t}" role="tab" aria-selected="${t === S.stremio.type}">${escapeHtml(TYPE_NAMES[t] || t)}</button>`).join('');
}
$('#dc-types').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  S.stremio.type = b.dataset.type;
  save();
  $('#dc-q').value = '';
  go({ kind: 'home' }, true);
});

function go(view, reset) {
  if (reset) DC.stack = [];
  else if (DC.view) DC.stack.push(DC.view);
  DC.view = view;
  draw();
}
function discoverBack() {
  if ($('#subs-menu') && !$('#subs-menu').classList.contains('hidden')) return hideSubsMenu();
  if (!DC.stack.length) return;
  DC.view = DC.stack.pop();
  draw();
}
$('#dc-back').onclick = discoverBack;

function draw() {
  const token = ++DC.token;
  $('#dc-back').disabled = !DC.stack.length;
  renderTypes();
  const v = DC.view;
  dcBody().scrollTop = 0;
  if (v.kind === 'home') drawHome(token);
  else if (v.kind === 'all') drawAll(v, token);
  else if (v.kind === 'search') drawSearch(v, token);
  else if (v.kind === 'detail') drawDetail(v, token);
}

function emptyState(text) {
  hideLoader();
  dcBody().innerHTML = `<div class="dc-empty">${icon('compass')}<h2>Nothing to show yet</h2><p>${text}</p>
    <button class="btn primary" data-cmd="manage-addons">${icon('puzzle')} Manage add-ons</button></div>`;
}

function rowHtml(title, sub, allKey) {
  return `<section class="dc-row"><div class="dc-row-head"><h3>${escapeHtml(title)}${sub ? ` <span class="dim">· ${escapeHtml(sub)}</span>` : ''}</h3>
    ${allKey ? `<button class="btn small" data-all="${allKey}">See all</button>` : ''}</div><div class="dc-row-items">${skeletons()}</div></section>`;
}
async function fillRow(rowEl, url, token, emptyText) {
  const items = rowEl.querySelector('.dc-row-items');
  try {
    const data = await getJSON(url);
    if (token !== DC.token) return [];
    const metas = (data.metas || []).filter((m) => m && m.id);
    items.innerHTML = metas.length ? metas.slice(0, 40).map(posterCard).join('') : `<p class="dim">${escapeHtml(emptyText || 'Nothing here.')}</p>`;
    return metas;
  } catch (err) {
    if (token !== DC.token) return [];
    items.innerHTML = `<p class="dim">Couldn't load this list: ${escapeHtml(err.message)}</p>`;
    return [];
  }
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function drawHome(token) {
  const type = S.stremio.type;
  const cats = allCatalogs().filter(({ cat }) => cat.type === type && !needsExtra(cat));
  if (!enabledAddons().length) return emptyState('Install a Stremio add-on to browse movies and series. Paste its link in Add-ons.');
  if (!cats.length) return emptyState(`None of your add-ons have ${escapeHtml((TYPE_NAMES[type] || type).toLowerCase())} lists to browse.`);
  // genres come from the first list that can be filtered by genre
  const genreCat = allCatalogs().find(({ cat }) => cat.type === type && catalogExtras(cat).some((e) => e.name === 'genre' && Array.isArray(e.options) && e.options.length));
  DC.genreCat = genreCat;
  const genres = genreCat ? catalogExtras(genreCat.cat).find((e) => e.name === 'genre').options.slice(0, 30) : [];
  const what = { movie: 'movie', series: 'show', channel: 'channel', tv: 'channel' }[type] || 'title';
  dcBody().innerHTML = `<div class="dc-home">
    <section class="dc-banner" id="dc-banner" hidden aria-label="Featured"></section>
    <div class="dc-greet">
      <div><h1>${greeting()} 👋</h1><p>What ${what} are we watching?</p></div>
      <button class="btn dc-surprise" id="dc-surprise" title="Pick something at random">🎲 Surprise me</button>
    </div>
    ${genres.length ? `<div class="dc-genres" role="list">${genres.map((g) => `<button class="dc-genre" role="listitem" data-genre="${escapeHtml(g)}">${escapeHtml(genreLabel(g))}</button>`).join('')}</div>` : ''}
    ${typeof continueRowHtml === 'function' ? continueRowHtml(type) : ''}
    ${typeof libraryRowsHtml === 'function' ? libraryRowsHtml(type) : ''}
    ${cats.map(({ addon, cat }, i) => rowHtml(rowTitle(cat), cats.length > 1 && new Set(cats.map((c) => c.addon)).size > 1 ? addon.manifest.name : '', `${i}`)).join('')}
  </div>`;
  DC.homeCats = cats;
  // load rows a few at a time so the first ones appear fast; the first one also feeds the banner
  const rows = [...dcBody().querySelectorAll('.dc-row:not(.lib)')];
  let next = 0;
  const worker = async () => {
    while (next < rows.length && token === DC.token) {
      const i = next++;
      const metas = await fillRow(rows[i], catalogUrl(cats[i].addon, cats[i].cat), token);
      if (i === 0) hideLoader();
      if (i === 0 && metas.length) setupBanner(metas, token);
    }
  };
  for (let w = 0; w < 3; w++) worker();
  drawEndless(cats, token);
}

// Under the rows: the whole Popular list as a grid that keeps loading as you scroll.
// Placed right after "Featured picks" when there is one, otherwise at the end.
function drawEndless(cats, token) {
  const pages = cats.filter(({ cat }) => hasExtra(cat, 'skip'));
  const src = pages.find(({ cat }) => /^(top|popular)$/i.test(cat.id) || /^popular$/i.test(cat.name || '')) || pages[0];
  if (!src) return;
  const rows = [...dcBody().querySelectorAll('.dc-row:not(.lib)')];
  const featured = rows[cats.findIndex(({ cat }) => /featured/i.test(cat.name || cat.id))];
  const section = document.createElement('section');
  section.className = 'dc-row dc-endless';
  section.innerHTML = `<div class="dc-row-head"><h3>All popular ${escapeHtml((TYPE_NAMES[src.cat.type] || src.cat.type).toLowerCase())}</h3></div>
    <div class="dc-grid"></div><div class="dc-more"><span class="dc-end-sentinel"></span></div>`;
  const anchor = featured || rows[rows.length - 1];
  if (anchor) anchor.after(section); else dcBody().querySelector('.dc-home').append(section);
  const grid = section.querySelector('.dc-grid');
  const seen = new Set();
  let skip = 0, busy = false, done = false;
  const load = async () => {
    if (busy || done || token !== DC.token) return;
    busy = true;
    grid.insertAdjacentHTML('beforeend', skeletons(12));
    try {
      const data = await getJSON(catalogUrl(src.addon, src.cat, skip ? { skip } : {}));
      if (token !== DC.token) return;
      const metas = (data.metas || []).filter((m) => m && m.id);
      skip += metas.length;
      const fresh = metas.filter((m) => !seen.has(m.id) && seen.add(m.id));
      grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
      grid.insertAdjacentHTML('beforeend', fresh.map(posterCard).join(''));
      if (!metas.length) { done = true; section.querySelector('.dc-more').innerHTML = '<p class="dim">That\'s everything.</p>'; }
    } catch (err) {
      grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
      done = true;
      section.querySelector('.dc-more').innerHTML = `<p class="dim">Couldn't load more: ${escapeHtml(err.message)}</p>`;
    } finally {
      busy = false;
    }
    // still near the bottom (tall window, or a page of repeats): keep going
    if (!done && sentinel.getBoundingClientRect().top < dcBody().getBoundingClientRect().bottom + 800) load();
  };
  const sentinel = section.querySelector('.dc-end-sentinel');
  const io = new IntersectionObserver((es) => {
    if (token !== DC.token || !section.isConnected) return io.disconnect();
    if (es.some((e) => e.isIntersecting)) load();
  }, { root: dcBody(), rootMargin: '800px' });
  io.observe(sentinel);
}

// big rotating "featured" banner at the top of the home page
function setupBanner(metas, token) {
  const picks = metas.filter((m) => safeHttp(m.background) || safeHttp(m.poster)).slice(0, 6);
  const el = $('#dc-banner');
  if (!el || !picks.length) return;
  el.hidden = false;
  let at = 0;
  const show = async (n) => {
    at = n;
    const m = picks[n];
    const k = reg(m);
    const facts = [m.releaseInfo, parseFloat(m.imdbRating) > 0 && `★ ${parseFloat(m.imdbRating).toFixed(1)}`, (m.genres || m.genre || []).slice(0, 3).join(' · ')].filter(Boolean).map((x) => escapeHtml(String(x))).join('  ·  ');
    el.innerHTML = `<div class="bn-bg" style="background-image:url(${escapeHtml(JSON.stringify(safeHttp(m.background) || safeHttp(m.poster)))})"></div><div class="bn-shade"></div>
      <div class="bn-info">
        <div class="bn-title"><h2>${escapeHtml(m.name || '')}</h2></div>
        <p class="bn-facts">${facts}</p>
        <p class="bn-desc">${escapeHtml(m.description || '')}</p>
        <div class="bn-actions"><button class="btn primary bn-watch" data-open="${k}">▶ Watch now</button></div>
      </div>
      <div class="bn-dots">${picks.map((p, j) => `<button class="${j === n ? 'on' : ''}" data-dot="${j}" aria-label="Show ${escapeHtml(p.name || '')}"></button>`).join('')}</div>`;
    // the logo and a fuller description come from the details
    const full = await fetchMeta(m.type, m.id).catch(() => null);
    if (!full || token !== DC.token || at !== n || !el.isConnected) return;
    if (safeHttp(full.logo)) el.querySelector('.bn-title').innerHTML = `<img class="bn-logo" src="${escapeHtml(full.logo)}" alt="${escapeHtml(m.name || '')}" data-fallback="title">`;
    if (full.description && !m.description) el.querySelector('.bn-desc').textContent = full.description;
    if (safeHttp(full.background) && !safeHttp(m.background)) el.querySelector('.bn-bg').style.backgroundImage = `url(${JSON.stringify(full.background)})`;
  };
  show(0);
  clearInterval(DC.bannerTimer);
  DC.bannerTimer = setInterval(() => {
    if (token !== DC.token || !el.isConnected) return clearInterval(DC.bannerTimer);
    if (el.matches(':hover') || el.contains(document.activeElement)) return; // don't move while you're looking
    show((at + 1) % picks.length);
  }, 9000);
  el.onclick = (e) => {
    const d = e.target.closest('[data-dot]');
    if (d) show(+d.dataset.dot);
  };
}

async function drawAll(v, token) {
  const { addon, cat } = v;
  dcBody().innerHTML = `<div class="dc-page-head"><h2>${escapeHtml(v.title || rowTitle(cat))} <span class="dim">· ${escapeHtml(addon.manifest.name)}</span></h2></div>
    <div class="dc-grid" id="dc-grid"></div><div class="dc-more"><button class="btn" id="dc-more" hidden>Load more</button></div>`;
  let skip = 0;
  const canSkip = hasExtra(cat, 'skip');
  const loadMore = async () => {
    const btn = $('#dc-more');
    btn.hidden = true;
    const grid = $('#dc-grid');
    grid.insertAdjacentHTML('beforeend', skeletons(12));
    try {
      const data = await getJSON(catalogUrl(addon, cat, { ...(v.extra || {}), ...(skip ? { skip } : {}) }));
      if (token !== DC.token) return;
      grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
      const metas = (data.metas || []).filter((m) => m && m.id);
      grid.insertAdjacentHTML('beforeend', metas.map(posterCard).join(''));
      skip += metas.length;
      btn.hidden = !canSkip || !metas.length;
    } catch (err) {
      grid.querySelectorAll('.skeleton').forEach((s) => s.remove());
      grid.insertAdjacentHTML('beforeend', `<p class="dim">Couldn't load more: ${escapeHtml(err.message)}</p>`);
    }
  };
  $('#dc-more').onclick = loadMore;
  loadMore();
}

function drawSearch(v, token) {
  const searchable = allCatalogs().filter(({ cat }) => hasExtra(cat, 'search'));
  if (!searchable.length) return emptyState('None of your add-ons support search.');
  dcBody().innerHTML = `<div class="dc-page-head"><h2>Results for “${escapeHtml(v.q)}”</h2></div>` +
    searchable.map(({ addon, cat }) => rowHtml(`${TYPE_NAMES[cat.type] || cat.type}`, `${cat.name || cat.id} · ${addon.manifest.name}`)).join('');
  [...dcBody().querySelectorAll('.dc-row')].forEach((row, i) => {
    const { addon, cat } = searchable[i];
    fillRow(row, catalogUrl(addon, cat, { search: v.q }), token, 'No matches.');
  });
}
$('#dc-q').addEventListener('input', (e) => {
  clearTimeout(DC.searchTimer);
  const q = e.target.value.trim();
  DC.searchTimer = setTimeout(() => {
    if (!q) go({ kind: 'home' }, true);
    else if (DC.view?.kind === 'search') { DC.view = { kind: 'search', q }; draw(); }
    else go({ kind: 'search', q });
  }, 450);
});

// ------------------------------------------------------------ details, episodes, streams
async function fetchMeta(type, id) {
  for (const addon of enabledAddons()) {
    if (!supports(addon, 'meta', type, id)) continue;
    try { const d = await getJSON(resourceUrl(addon, 'meta', type, id)); if (d && d.meta) return d.meta; } catch { /* next add-on */ }
  }
  return null;
}

async function drawDetail(v, token) {
  const stub = v.meta;
  dcBody().innerHTML = `<div class="dc-detail"><div class="dc-hero"></div><div class="dc-detail-main"><div class="dc-poster">${safeHttp(stub.poster) ? `<img src="${escapeHtml(stub.poster)}" alt="">` : ''}</div>
    <div class="dc-info"><h1>${escapeHtml(stub.name || '')}</h1><p class="dim">Loading details…</p></div></div></div>`;
  const meta = (await fetchMeta(stub.type, stub.id)) || stub;
  if (token !== DC.token) return;
  v.full = meta;
  const facts = [meta.releaseInfo || meta.year, meta.runtime, meta.imdbRating && `★ ${meta.imdbRating}`].filter(Boolean).map((x) => escapeHtml(String(x))).join(' · ');
  const genres = (meta.genres || meta.genre || []).slice(0, 6).map((g) => `<span class="dc-chip">${escapeHtml(g)}</span>`).join('');
  const bg = safeHttp(meta.background);
  const logo = safeHttp(meta.logo);
  const videos = (meta.videos || []).filter((x) => x && x.id);
  // opened from Continue watching: go straight to that episode
  const resumeId = v.meta.resumeVideoId;
  if (!v.video && resumeId) {
    v.video = videos.find((x) => x.id === resumeId) || null;
    if (v.video) v.season = v.video.season ?? 1;
  }
  dcBody().innerHTML = `<div class="dc-detail">
    <div class="dc-hero">${bg ? `<img src="${escapeHtml(bg)}" alt="" data-fallback="remove">` : ''}</div>
    <div class="dc-detail-main">
      <div class="dc-poster">${safeHttp(meta.poster) ? `<img src="${escapeHtml(meta.poster)}" alt="">` : ''}</div>
      <div class="dc-info">
        ${logo ? `<img class="dc-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(meta.name || '')}" data-fallback="title">` : `<h1>${escapeHtml(meta.name || '')}</h1>`}
        <p class="dc-facts">${facts}</p>
        <div class="dc-chips">${genres}</div>
        <p class="dc-desc">${escapeHtml(meta.description || '')}</p>
      </div>
    </div>
    <div class="dc-split">
      ${videos.length ? `<div class="dc-episodes"><div class="row gap"><h3>Episodes</h3><select class="input dc-season" id="dc-season"></select></div><ol id="dc-eps"></ol></div>` : ''}
      <div class="dc-streams" id="dc-streams"></div>
    </div></div>`;
  if (videos.length) {
    const seasons = [...new Set(videos.map((x) => x.season ?? 1))].sort((a, b) => (a === 0) - (b === 0) || a - b);
    const sel = $('#dc-season');
    sel.innerHTML = seasons.map((s) => `<option value="${s}">${s === 0 ? 'Specials' : `Season ${s}`}</option>`).join('');
    sel.value = String(v.season ?? seasons[0]);
    const drawEps = () => {
      v.season = +sel.value;
      const eps = videos.filter((x) => (x.season ?? 1) === v.season).sort((a, b) => (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0));
      $('#dc-eps').innerHTML = eps.map((ep) => {
        const n = ep.episode ?? ep.number;
        const aired = ep.released ? new Date(ep.released) : null;
        const future = aired && aired > new Date();
        return `<li><button class="dc-ep ${v.video?.id === ep.id ? 'active' : ''}" data-ep="${escapeHtml(ep.id)}" ${future ? 'disabled' : ''}>
          ${safeHttp(ep.thumbnail) ? `<img loading="lazy" src="${escapeHtml(ep.thumbnail)}" alt="" data-fallback="remove">` : '<span class="dc-ep-noimg"></span>'}
          <span><b>${n != null ? n + '. ' : ''}${escapeHtml(ep.title || ep.name || 'Episode')}</b>
          <span class="dim small">${aired && !isNaN(aired) ? (future ? 'Coming ' : '') + aired.toLocaleDateString() : ''}</span></span></button></li>`;
      }).join('');
    };
    sel.onchange = drawEps;
    drawEps();
    $('#dc-eps').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ep]');
      if (!b) return;
      v.video = videos.find((x) => x.id === b.dataset.ep);
      $$('#dc-eps .dc-ep').forEach((x) => x.classList.toggle('active', x === b));
      loadStreams(meta, v.video, token);
    });
    if (v.video) loadStreams(meta, v.video, token);
    else $('#dc-streams').innerHTML = '<p class="dim dc-hint">Pick an episode to see its streams.</p>';
  } else {
    loadStreams(meta, null, token);
  }
}

function streamKind(s) {
  if (s.url) return /^https?:/i.test(s.url) ? { k: 'url', label: 'Play' } : { k: 'none', label: 'Not supported' };
  if (s.infoHash) return { k: 'torrent', label: 'Torrent' };
  if (s.ytId) return { k: 'yt', label: 'YouTube' };
  if (s.externalUrl) return { k: 'ext', label: 'Opens outside' };
  return { k: 'none', label: 'Not supported' };
}
const lines = (t) => escapeHtml(String(t || '')).replace(/\n/g, '<br>');

async function loadStreams(meta, video, token) {
  const panel = $('#dc-streams');
  const type = meta.type;
  const vid = video ? video.id : meta.id;
  const addons = enabledAddons().filter((a) => supports(a, 'stream', type, vid));
  panel.dataset.vid = vid;
  if (!addons.length) {
    panel.innerHTML = `<div class="dc-note"><b>No streams yet.</b> None of your add-ons provide streams for this. Add one that does in
      <button class="btn small" data-cmd="manage-addons">${icon('puzzle')} Add-ons</button></div>`;
    return;
  }
  // every add-on's streams in one list that can be sorted and filtered (or grouped by add-on)
  const SL = DC.streamList = { vid, meta, video, items: [], pending: addons.length, errors: [], quality: 'all' };
  panel.innerHTML = `<h3>Streams${video ? ` · ${escapeHtml(video.title || video.name || '')}` : ''}</h3>
    <div class="dc-sbar" id="dc-sbar"></div><div id="dc-slist"></div>`;
  renderStreamList();
  await Promise.all(addons.map(async (a, order) => {
    try {
      const data = await getJSON(resourceUrl(a, 'stream', type, vid), { ttl: 2 * 60 * 1000 });
      if (token !== DC.token || panel.dataset.vid !== vid) return;
      (data.streams || []).filter(Boolean).forEach((s, i) => {
        SL.items.push({ s, addon: a, order, i, kind: streamKind(s), info: streamInfo(s), k: reg({ s, meta, video, addon: a.manifest.name, addonObj: a }) });
      });
    } catch (err) {
      if (token !== DC.token) return;
      SL.errors.push(`${a.manifest.name} didn't answer: ${err.message}`);
    }
    if (DC.streamList !== SL) return;
    SL.pending--;
    renderStreamList();
  }));
}

// ---- what a stream offers, read from the text add-ons put in its name and title
const QUALITY_RANK = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, '': 1.5, CAM: -2 };
function streamInfo(s) {
  const text = [s.name, s.title, s.description, s.behaviorHints?.filename].filter(Boolean).join(' ');
  let quality = '';
  if (/\b(cam|camrip|hdcam|hd-?ts|telesync|tsrip)\b/i.test(text)) quality = 'CAM';
  else if (/2160p|\b4k\b|\buhd\b/i.test(text)) quality = '4K';
  else if (/1080p|\bfhd\b/i.test(text)) quality = '1080p';
  else if (/720p|\bhd\b/i.test(text)) quality = '720p';
  else if (/480p|576p|\bsd\b/i.test(text)) quality = '480p';
  const hdr = /dolby ?vision|\bdv\b|\bdovi\b/i.test(text) ? 'Dolby Vision' : /\bhdr(10\+?)?\b/i.test(text) ? 'HDR' : '';
  let size = Number(s.behaviorHints?.videoSize) || 0;
  if (!size) {
    const m = /(?:💾\s*)?(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)\b/i.exec(text);
    if (m) size = parseFloat(m[1].replace(',', '.')) * { TB: 1e12, GB: 1e9, MB: 1e6 }[m[2].toUpperCase()];
  }
  const sm = /👤\s*(\d+)/.exec(text) || /\bseed(?:er)?s?\s*[:=]?\s*(\d+)/i.exec(text);
  return { quality, hdr, size, seeders: sm ? +sm[1] : null };
}
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB' : Math.round(b / 1e6) + ' MB';
// "best": the quality you usually pick first, then better quality, more people sharing, a sensible size
function streamScore(it) {
  if (it.kind.k !== 'url' && it.kind.k !== 'torrent') return -1e6;
  const q = it.info.quality;
  const seeders = it.info.seeders ?? (it.kind.k === 'url' ? 120 : 10);
  let sc = (q && q === S.stremio.prefQuality ? 100 : 0) + QUALITY_RANK[q] * 10 + Math.min(seeders, 400) / 40;
  if (it.info.size > 30e9) sc -= 6; // huge remuxes take long to start
  return sc;
}
function sortedStreams() {
  const SL = DC.streamList;
  let list = SL.items.filter((it) => SL.quality === 'all' || it.info.quality === SL.quality);
  const sort = S.stremio.streamSort;
  const byOrder = (a, b) => a.order - b.order || a.i - b.i;
  if (S.stremio.streamGroup) return list.sort(byOrder);
  if (sort === 'small') list.sort((a, b) => (a.info.size || 9e15) - (b.info.size || 9e15) || byOrder(a, b));
  else if (sort === 'seeders') list.sort((a, b) => (b.info.seeders ?? -1) - (a.info.seeders ?? -1) || byOrder(a, b));
  else list.sort((a, b) => streamScore(b) - streamScore(a) || byOrder(a, b));
  return list;
}
function bestStream() {
  const SL = DC.streamList;
  return SL && SL.items.slice().sort((a, b) => streamScore(b) - streamScore(a))[0];
}
function streamRowHtml(it, showAddon) {
  const { s, kind, info } = it;
  const q = info.quality;
  const badges = [
    q ? `<span class="sb-q q-${q.toLowerCase()}">${q}</span>` : '',
    info.hdr ? `<span class="sb-hdr">${info.hdr}</span>` : '',
    info.size ? `<span class="sb-meta">💾 ${fmtSize(info.size)}</span>` : '',
    info.seeders != null ? `<span class="sb-meta">👤 ${info.seeders}</span>` : '',
    showAddon ? `<span class="sb-addon">${escapeHtml(it.addon.manifest.name)}</span>` : '',
  ].join('');
  const canQueue = kind.k === 'url' || kind.k === 'torrent';
  return `<div class="ds-row"><button class="dc-stream kind-${kind.k}" data-k="${it.k}" ${kind.k === 'none' ? 'disabled' : ''}>
    <span class="ds-name">${lines(s.name || it.addon.manifest.name)}</span>
    <span class="ds-body"><span class="ds-badges">${badges}</span><span class="ds-title">${lines(String(s.title || s.description || '').replace(/[ \t]*(💾\s*[\d.,]+\s*[KMGT]B|👤\s*\d+)/g, ''))}</span></span>
    <span class="ds-kind">${escapeHtml(kind.label)}</span></button>${canQueue ? `<button class="icon-btn ds-add" data-add="${it.k}" title="Add to playlist" aria-label="Add to playlist">${icon('listAdd')}</button>` : ''}</div>`;
}
function renderStreamList() {
  const SL = DC.streamList;
  const bar = $('#dc-sbar'), host = $('#dc-slist');
  if (!SL || !bar || !host) return;
  const n = SL.items.length;
  const qualities = ['4K', '1080p', '720p', '480p', 'CAM'].filter((q) => SL.items.some((it) => it.info.quality === q));
  if (SL.quality !== 'all' && !qualities.includes(SL.quality)) SL.quality = 'all';
  const chip = (attr, val, label, on) => `<button class="chip dc-schip ${on ? 'active' : ''}" ${attr}="${val}">${label}</button>`;
  const best = bestStream();
  bar.innerHTML = n ? `
    <button class="btn primary dc-best" data-sbest ${best && streamScore(best) > -1e5 ? '' : 'disabled'}>${icon('play')} Play best${best?.info.quality ? ` · ${best.info.quality}` : ''}</button>
    <div class="dc-sopts">
      <span class="dim small">Sort</span>
      ${chip('data-ssort', 'best', '✨ Best', S.stremio.streamSort === 'best' && !S.stremio.streamGroup)}
      ${chip('data-ssort', 'small', '💾 Smallest', S.stremio.streamSort === 'small' && !S.stremio.streamGroup)}
      ${chip('data-ssort', 'seeders', '👤 Most shared', S.stremio.streamSort === 'seeders' && !S.stremio.streamGroup)}
      ${chip('data-ssort', 'group', '🧩 By add-on', S.stremio.streamGroup)}
    </div>
    ${qualities.length > 1 ? `<div class="dc-sopts"><span class="dim small">Quality</span>${chip('data-sq', 'all', 'All', SL.quality === 'all')}${qualities.map((q) => chip('data-sq', q, q, SL.quality === q)).join('')}</div>` : ''}` : '';
  const list = sortedStreams();
  let html = '';
  if (S.stremio.streamGroup) {
    let last = -1;
    for (const it of list) {
      if (it.order !== last) { html += `<h4 class="dc-shead">${escapeHtml(it.addon.manifest.name)}</h4>`; last = it.order; }
      html += streamRowHtml(it, false);
    }
  } else html = list.map((it) => streamRowHtml(it, true)).join('');
  if (SL.pending) html += `<p class="dim small dc-searching"><span class="spinner tiny"></span> Searching ${SL.pending} more add-on${SL.pending === 1 ? '' : 's'}…</p>`;
  else if (!n) html += '<p class="dim">No streams found for this. Try another add-on.</p>';
  else if (!list.length) html += '<p class="dim small">No streams in that quality.</p>';
  html += SL.errors.map((e) => `<p class="dim small">${escapeHtml(e)}</p>`).join('');
  host.innerHTML = html;
}

function episodeLabel(meta, video) {
  if (!video) return meta.name;
  const n = video.episode ?? video.number;
  const se = video.season != null && n != null ? ` S${String(video.season).padStart(2, '0')}E${String(n).padStart(2, '0')}` : '';
  const t = video.title || video.name;
  return `${meta.name}${se}${t ? ' · ' + t : ''}`;
}

const TORRENT_NOTICE = 'Torrent streams download the video from other people and share pieces of it back while you watch.\n\n'
  + 'Your IP address is visible to others sharing the same torrent, and in many countries sharing copyrighted videos is illegal. '
  + 'Only watch videos you have the right to watch.\n\nPlay this torrent stream?';

// queue: add it to the playlist instead of playing it now
async function playStream({ s, meta, video, addon, addonObj, queue = false }) {
  const title = episodeLabel(meta, video);
  const source = addonObj || enabledAddons().find((a) => a.manifest.name === addon) || null;
  const stremio = {
    type: meta.type, id: video ? video.id : meta.id, metaId: meta.id, name: meta.name, poster: safeHttp(meta.poster) || null,
    logo: safeHttp(meta.logo) || null, background: safeHttp(meta.background) || null, // for the loading screen
  };
  const kind = streamKind(s).k;
  // the add-on's stream text (often lists codecs like "DDP5.1" or "x265"); lets the player guess what to expect
  const hint = [s.name, s.title, s.description, s.behaviorHints?.filename].filter((x) => typeof x === 'string').join(' ');
  const subs = Array.isArray(s.subtitles) ? s.subtitles : [];
  const resumeAt = (typeof resumeFor === 'function' ? resumeFor(meta, video) : 0) || (typeof libraryResumeFor === 'function' ? libraryResumeFor(meta, video) : 0);
  const nx = typeof nextEpisodeOf === 'function' ? nextEpisodeOf(meta, video) : null;
  const cw = { s, addonUrl: source ? source.transportUrl : null, ep: video ? { season: video.season, episode: video.episode ?? video.number, title: video.title || video.name } : null,
    next: nx ? { id: nx.id, season: nx.season, episode: nx.episode ?? nx.number } : null };
  const start = queue ? queueRemote : playRemote;
  if (kind === 'url') {
    if (!queue) armUpNext({ meta, video, s, addon: source, path: s.url });
    start({ path: s.url, name: title, title, remote: { headers: s.behaviorHints?.proxyHeaders?.request || null }, stremio, subs, resumeAt, hint, cw });
  } else if (kind === 'torrent') {
    if (!S.stremio.torrentNoticeSeen) {
      if (!confirm(TORRENT_NOTICE)) return;
      S.stremio.torrentNoticeSeen = true;
      save();
    }
    // Engine: 'auto' uses Stremio's engine when Stremio is installed (faster), else the built-in one.
    const engine = S.stremio.torrentEngine;
    const hash = String(s.infoHash).toLowerCase();
    const idx = Number.isInteger(s.fileIdx) ? s.fileIdx : -1;
    const trackers = (s.sources || []).filter((x) => typeof x === 'string' && x.startsWith('tracker:')).map((x) => x.slice(8));
    if (!queue) armUpNext({ meta, video, s, addon: source, path: `magnet:?xt=urn:btih:${hash}&idx=${idx}` });
    start({
      path: `magnet:?xt=urn:btih:${hash}&idx=${idx}`, name: title, title, stremio, subs, resumeAt, hint, cw,
      torrent: { infoHash: hash, fileIdx: idx, trackers, name: s.behaviorHints?.filename || meta.name },
      viaStremio: engine === 'builtin' ? null : { mustUse: engine === 'stremio' },
    });
  } else if (kind === 'yt') {
    window.open('https://www.youtube.com/watch?v=' + encodeURIComponent(s.ytId));
  } else if (kind === 'ext') {
    if (/^https?:/i.test(s.externalUrl)) window.open(s.externalUrl);
    else osd('This link only opens in the Stremio app');
  }
}

dcBody().addEventListener('click', (e) => {
  const all = e.target.closest('[data-all]');
  if (all) { const c = DC.homeCats[+all.dataset.all]; return go({ kind: 'all', addon: c.addon, cat: c.cat }); }
  const genre = e.target.closest('[data-genre]');
  if (genre && DC.genreCat) {
    const g = genre.dataset.genre;
    return go({ kind: 'all', addon: DC.genreCat.addon, cat: DC.genreCat.cat, extra: { genre: g }, title: genreLabel(g) });
  }
  const open = e.target.closest('[data-open]');
  if (open && DC.reg.get(open.dataset.open)) return go({ kind: 'detail', meta: DC.reg.get(open.dataset.open) });
  if (e.target.closest('#dc-surprise')) return surpriseMe();
  const card = e.target.closest('.dc-card[data-k]');
  if (card && DC.reg.get(card.dataset.k)?.cwId) return resumeFromHistory(DC.reg.get(card.dataset.k).cwId); // Continue watching
  if (card) return go({ kind: 'detail', meta: DC.reg.get(card.dataset.k) });
  const sort = e.target.closest('[data-ssort]');
  if (sort) {
    const v = sort.dataset.ssort;
    if (v === 'group') S.stremio.streamGroup = !S.stremio.streamGroup;
    else { S.stremio.streamSort = v; S.stremio.streamGroup = false; }
    save();
    return renderStreamList();
  }
  const sq = e.target.closest('[data-sq]');
  if (sq && DC.streamList) { DC.streamList.quality = sq.dataset.sq; return renderStreamList(); }
  if (e.target.closest('[data-sbest]')) { const b = bestStream(); if (b) playStream(DC.reg.get(b.k)); return; }
  const add = e.target.closest('[data-add]');
  if (add) return playStream({ ...DC.reg.get(add.dataset.add), queue: true });
  const st = e.target.closest('.dc-stream[data-k]');
  if (st) {
    // the quality you pick by hand becomes what "Play best" goes for next time
    const q = streamInfo(DC.reg.get(st.dataset.k).s).quality;
    if (q && q !== 'CAM' && q !== S.stremio.prefQuality) { S.stremio.prefQuality = q; save(); }
    return playStream(DC.reg.get(st.dataset.k));
  }
});

// resting the mouse on a torrent stream (or focusing it with the keyboard / TV remote) warms it up
let warmHover = null;
function warmFrom(el) {
  clearTimeout(warmHover);
  const b = el && el.closest('.dc-stream.kind-torrent[data-k]');
  if (!b) return;
  warmHover = setTimeout(() => {
    const it = DC.reg.get(b.dataset.k);
    if (!it || !it.s || typeof warmTorrent !== 'function') return;
    const trackers = (it.s.sources || []).filter((x) => typeof x === 'string' && x.startsWith('tracker:')).map((x) => x.slice(8));
    warmTorrent(String(it.s.infoHash || '').toLowerCase(), trackers);
  }, 500);
}
dcBody().addEventListener('mouseover', (e) => warmFrom(e.target));
dcBody().addEventListener('mouseout', (e) => { if (!e.relatedTarget || !e.relatedTarget.closest('.dc-stream.kind-torrent')) clearTimeout(warmHover); });
dcBody().addEventListener('focusin', (e) => warmFrom(e.target));

// 🎲 pick something at random from the lists on the page, with a quick shuffle of posters first
function surpriseMe() {
  const cards = [...dcBody().querySelectorAll('.dc-row:not(.lib) .dc-card[data-k]')];
  if (!cards.length) return osd('Wait a moment for the lists to load');
  const btn = $('#dc-surprise');
  if (btn) btn.disabled = true;
  let n = 0;
  const flick = setInterval(() => {
    cards.forEach((c) => c.classList.remove('spotlight'));
    const c = cards[Math.floor(Math.random() * cards.length)];
    c.classList.add('spotlight');
    c.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    if (++n >= 9) {
      clearInterval(flick);
      setTimeout(() => {
        c.classList.remove('spotlight');
        if (btn) btn.disabled = false;
        osd(`🎲 How about ${DC.reg.get(c.dataset.k)?.name || 'this'}?`, 2200);
        go({ kind: 'detail', meta: DC.reg.get(c.dataset.k) });
      }, 450);
    }
  }, 130);
}

// ------------------------------------------------------------ subtitles from add-ons
const LANG_ALT = { eng: ['en'], spa: ['es', 'spn'], fre: ['fr', 'fra'], ger: ['de', 'deu'], ita: ['it'], por: ['pt'], pob: ['pt-br', 'ptbr'], dut: ['nl', 'nld'],
  pol: ['pl'], rus: ['ru'], ukr: ['uk'], tur: ['tr'], ara: ['ar'], heb: ['he', 'iw'], per: ['fa', 'fas'], hin: ['hi'], jpn: ['ja'], kor: ['ko'], chi: ['zh', 'zho', 'zht', 'zhs'],
  gre: ['el', 'ell'], swe: ['sv'], nor: ['no', 'nb'], dan: ['da'], fin: ['fi'], rum: ['ro', 'ron'], hun: ['hu'], cze: ['cs', 'ces'] };
function langMatches(lang, pref) {
  const l = String(lang || '').toLowerCase();
  return l === pref || (LANG_ALT[pref] || []).includes(l);
}
function langName(code) {
  const l = String(code || '').toLowerCase();
  const key = Object.keys(LANG_ALT).find((k) => k === l || LANG_ALT[k].includes(l));
  const two = key ? (LANG_ALT[key][0] || key) : l;
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(two) || code; } catch { return code || 'Unknown'; }
}

// Subtitles from every source go into current.subs, ranked:
//   0 = subtitle files inside the torrent (made for this exact video)
//   1 = subtitles built into the video file
//   2 = subtitle add-ons (e.g. OpenSubtitles) and ones the stream lists
// Your language is picked from the best-ranked source; if a better one arrives later, it switches,
// unless you picked subtitles yourself.
const SUB_LANG_WORDS = {
  eng: ['en', 'eng', 'english'], spa: ['es', 'spa', 'spanish', 'espanol', 'español', 'castellano', 'latino'], fre: ['fr', 'fre', 'fra', 'french', 'francais', 'français'],
  ger: ['de', 'ger', 'deu', 'german', 'deutsch'], ita: ['it', 'ita', 'italian', 'italiano'], por: ['pt', 'por', 'portuguese', 'portugues'], pob: ['pob', 'ptbr', 'pt-br', 'brazilian'],
  dut: ['nl', 'dut', 'nld', 'dutch'], pol: ['pl', 'pol', 'polish'], rus: ['ru', 'rus', 'russian'], ukr: ['uk', 'ukr', 'ukrainian'], tur: ['tr', 'tur', 'turkish'],
  ara: ['ar', 'ara', 'arabic'], heb: ['he', 'heb', 'hebrew'], per: ['fa', 'per', 'fas', 'persian', 'farsi'], hin: ['hi', 'hin', 'hindi'], jpn: ['ja', 'jpn', 'japanese'],
  kor: ['ko', 'kor', 'korean'], chi: ['zh', 'chi', 'zho', 'chs', 'cht', 'chinese'], gre: ['el', 'gre', 'ell', 'greek'], swe: ['sv', 'swe', 'swedish'],
  nor: ['no', 'nor', 'nob', 'norwegian'], dan: ['da', 'dan', 'danish'], fin: ['fi', 'fin', 'finnish'], rum: ['ro', 'rum', 'ron', 'romanian'], hun: ['hu', 'hun', 'hungarian'], cze: ['cs', 'cze', 'ces', 'czech'],
};
// "Movie.2020.English.srt" / "movie.en.forced.srt" -> 'eng'
function langFromFileName(name) {
  const words = String(name).toLowerCase().replace(/\.[a-z0-9]+$/, '').split(/[._\-\s()[\]]+/);
  for (let i = words.length - 1; i >= 0; i--) {
    const code = Object.keys(SUB_LANG_WORDS).find((k) => SUB_LANG_WORDS[k].includes(words[i]));
    if (code) return code;
  }
  return '';
}
const SUB_FILE = /\.(srt|vtt|ass|ssa|sub)$/i;
const subLabel = (s) => `${s.lang ? langName(s.lang) : 'Subtitles'} · ${s.source}`;

function addStreamSubs(entries) {
  if (!current) return;
  current.subs = [...(current.subs || []), ...entries].sort((a, b) => a.rank - b.rank);
  autoPickSubs();
}
// called once a torrent's file list and the video's own tracks are known
// ---- your subtitle choice per show (language + where it came from, on/off, timing)
const subKey = (s) => `${s.lang || ''}|${s.source}`;
function showPref() {
  const id = current?.item?.stremio?.metaId;
  return id ? S.stremio.showPrefs[id] || null : null;
}
function rememberShowSubs({ off } = {}) {
  const id = current?.item?.stremio?.metaId;
  if (!id) return;
  const prev = S.stremio.showPrefs[id] || {};
  const now = (current.subs || []).find((x) => subLabel(x) === SUBS.label);
  const sub = off || SUBS.hidden ? 'off' : now ? subKey(now) : prev.sub || null;
  delete S.stremio.showPrefs[id]; // re-added last, so the oldest shows drop off first
  S.stremio.showPrefs[id] = { sub, delay: SUBS.delay || 0 };
  const ids = Object.keys(S.stremio.showPrefs);
  ids.slice(0, Math.max(0, ids.length - 300)).forEach((k) => delete S.stremio.showPrefs[k]);
  save();
}

function collectStreamSubs(files, base, plan) {
  if (current) current.awaitStreamSubs = false;
  const pref = showPref();
  if (pref) { SUBS.delay = pref.delay || 0; SUBS.hidden = pref.sub === 'off'; }
  const list = [];
  for (const f of files || []) {
    if (!SUB_FILE.test(f.name)) continue;
    list.push({ kind: 'file', url: base + f.i, lang: langFromFileName(f.name), source: 'Torrent', name: f.name, rank: 0 });
  }
  for (const s of (plan && plan.subs) || []) {
    if (!s.text) continue; // picture subtitles (PGS/DVD) can't be shown as text
    list.push({ kind: 'embedded', index: s.index, lang: s.lang && s.lang !== 'und' ? s.lang : '', source: 'In the video', rank: 1 });
  }
  addStreamSubs(list);
}
function autoPickSubs() {
  if (!current || current.subManual || current.awaitStreamSubs) return;
  const pref = S.stremio.subLang;
  if (!pref) return;
  const list = current.subs || [];
  // what you chose for this show last time comes first
  const sp = showPref();
  const mine = sp && sp.sub && sp.sub !== 'off' ? list.find((s) => subKey(s) === sp.sub) : null;
  if (mine) {
    if (current.subAuto === mine) return;
    current.subAuto = mine;
    return loadSubEntry(mine, true);
  }
  let pick = list.find((s) => langMatches(s.lang, pref));
  // a torrent's own subtitles with no language in the name: most likely made for this release
  if (!pick) pick = list.find((s) => s.rank < 2 && !s.lang);
  if (!pick) return;
  if (current.subAuto && current.subAuto.rank <= pick.rank) return; // already showing as good or better
  current.subAuto = pick;
  loadSubEntry(pick, true);
}
async function loadSubEntry(s, quiet) {
  const label = subLabel(s);
  if (s.kind === 'embedded') return startEmbeddedSubs({ index: s.index, label }, quiet);
  const r = s.kind === 'file' ? await api.subsConvert(s.url, null) : await api.addonFetch(s.url, 'text');
  if (!r.ok) return showError(`Couldn't load those subtitles: ${r.error}`);
  loadSubtitleText(s.kind === 'file' ? r.text : r.data, label, quiet);
}

async function loadAddonSubs(item, token) {
  const { type, id } = item.stremio;
  const found = (item.subs || []).filter((x) => x && safeHttp(x.url)).map((x) => ({ ...x, kind: 'addon', source: 'Stream', rank: 2 }));
  const addons = enabledAddons().filter((a) => supports(a, 'subtitles', type, id));
  const results = await Promise.all(addons.map((a) => getJSON(resourceUrl(a, 'subtitles', type, id))
    .then((d) => (d.subtitles || []).filter((x) => x && safeHttp(x.url)).map((x) => ({ ...x, kind: 'addon', source: a.manifest.name, rank: 2 })))
    .catch(() => [])));
  results.forEach((r) => found.push(...r));
  if (!current || current.item !== item || token !== loadToken) return;
  addStreamSubs(found);
}

// the CC button: pick from add-on subtitles, or load a file
function showSubsMenu() {
  const menu = $('#subs-menu');
  const subs = current?.subs || [];
  // the torrent's own subtitles first, then the rest grouped by language
  const own = subs.map((s, i) => i).filter((i) => subs[i].rank < 2);
  const byLang = new Map();
  subs.forEach((x, i) => { if (x.rank < 2) return; const n = x.lang ? langName(x.lang) : 'Other'; if (!byLang.has(n)) byLang.set(n, []); byLang.get(n).push(i); });
  const pref = langName(S.stremio.subLang);
  const langs = [...byLang.keys()].sort((a, b) => (b === pref) - (a === pref) || a.localeCompare(b));
  const item = (i, extra = '') => {
    const s = subs[i];
    return `<button data-sub="${i}" role="menuitem" class="${current.subLabel === subLabel(s) ? 'on' : ''}">${escapeHtml(s.lang ? langName(s.lang) : (s.name || 'Subtitles'))}${extra} <span class="dim small">${escapeHtml(s.source)}</span></button>`;
  };
  menu.innerHTML = `<button data-sub="off" role="menuitem">Off</button>` +
    (own.length ? `<div class="pop-head">From this video</div>` + own.map((i) => item(i)).join('') + (langs.length ? `<div class="pop-head">From add-ons</div>` : '') : '') +
    langs.map((n) => byLang.get(n).slice(0, 6).map((i, j) => item(i, byLang.get(n).length > 1 ? ` <span class="dim">#${j + 1}</span>` : '')).join('')).join('') +
    `<button data-sub="file" role="menuitem">${icon('file')} From a file…</button>` +
    `<div class="sub-quick" role="group" aria-label="Subtitle timing and size">
      <span class="dim small">Timing</span>
      <button data-sqd="-0.1" title="Earlier (G)">−</button><span id="sq-delay">${fmtDelay(SUBS.delay)}</span><button data-sqd="0.1" title="Later (H)">+</button>
      <span class="dim small">Size</span>
      <button data-sqs="-10" title="Smaller (Alt −)">A−</button><button data-sqs="10" title="Bigger (Alt +)">A+</button>
      <button data-sqr title="Reset timing">Reset</button>
    </div>`;
  const watching = document.body.classList.contains('watch');
  const btn = $(watching ? '#w-subs' : '[data-cmd="subs"]').getBoundingClientRect();
  menu.classList.remove('hidden');
  menu.style.left = Math.max(8, Math.min(btn.left, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = (watching ? Math.max(8, btn.top - menu.offsetHeight - 8) : btn.bottom + 6) + 'px';
  menu.querySelector('button')?.focus();
}
function hideSubsMenu() { $('#subs-menu').classList.add('hidden'); }
$('#subs-menu').addEventListener('click', async (e) => {
  const q = e.target.closest('[data-sqd],[data-sqs],[data-sqr]');
  if (q) {
    if (q.dataset.sqd) setSubDelay(SUBS.delay + +q.dataset.sqd);
    else if (q.dataset.sqs) stepSubSize(Math.sign(+q.dataset.sqs));
    else setSubDelay(0);
    return;
  }
  const b = e.target.closest('[data-sub]');
  if (!b) return;
  hideSubsMenu();
  const v = b.dataset.sub;
  if (current) current.subManual = true; // your choice wins over automatic picks
  if (v === 'off') { removeSubtitles(); osd('Subtitles off'); rememberShowSubs({ off: true }); }
  else if (v === 'file') { const p = await api.openSubtitle(); if (p) loadSubtitle(p); }
  else { SUBS.hidden = false; await loadSubEntry(current.subs[+v]); rememberShowSubs(); }
});
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#subs-menu') && !e.target.closest('[data-cmd="subs"]')) hideSubsMenu();
});

// a message after leaving a stream (e.g. "Nobody is sharing this torrent"), shown above the streams
function showDiscoverNotice(text) {
  const host = $('#dc-streams') || dcBody();
  if (!host) return;
  host.querySelectorAll('.dc-note.leave').forEach((n) => n.remove());
  const n = document.createElement('div');
  n.className = 'dc-note warn leave';
  n.setAttribute('role', 'status');
  n.textContent = text;
  host.prepend(n);
  n.scrollIntoView({ block: 'nearest' });
  setTimeout(() => n.remove(), 20000);
}

// broken poster/logo images: drop them, or show the title instead of a missing logo
// Title logos reveal left to right behind a soft transparent edge once the image has loaded.
document.addEventListener('load', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.matches('.bn-logo, .dc-logo')) return;
  img.classList.add('reveal');
  // drop the mask once the wipe ends so it can't clip the logo's shadow
  const done = () => img.classList.replace('reveal', 'shown');
  img.addEventListener('animationend', done, { once: true });
  setTimeout(done, 1300); // backup: the banner's own entrance animation can swallow animationend
}, true);
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  if (img.dataset.fallback === 'title') { const h = document.createElement('h1'); h.textContent = img.alt; img.replaceWith(h); }
  else img.remove();
}, true);

// ------------------------------------------------------------ entry points
// Loading screen: the logo sits greyed out while its colour fills in from the bottom.
function showLoader(text) {
  hideLoader(true);
  const el = document.createElement('div');
  el.className = 'js-loader';
  el.id = 'js-loader';
  el.setAttribute('role', 'status');
  el.innerHTML = `<div class="jl-logo" aria-hidden="true"><span class="jl-base"></span><span class="jl-fill"></span></div><p>${escapeHtml(text)}</p>`;
  $('#discover').append(el);
  clearTimeout(DC.loaderTimer);
  DC.loaderTimer = setTimeout(() => hideLoader(), 15000); // never hang on a slow add-on
}
function hideLoader(now) {
  const el = $('#js-loader');
  if (!el) return;
  clearTimeout(DC.loaderTimer);
  if (now) return el.remove();
  el.classList.add('done');
  setTimeout(() => el.remove(), 350);
}

async function openDiscover() {
  if (!DC.started) {
    DC.started = true;
    // start the torrent engines now, so the first stream you pick doesn't wait for them
    if (S.stremio.torrentEngine !== 'builtin') api.stremioServerEnsure((S.stremio.server || 'http://127.0.0.1:11470').replace(/\/+$/, '')).catch(() => {});
    if (S.stremio.torrentEngine !== 'stremio') api.torrentWarm().catch(() => {});
    dcBody().innerHTML = '';
    showLoader('Getting your add-ons ready…');
    await ensureAddons();
    go({ kind: 'home' }, true);
  } else if (!DC.view) go({ kind: 'home' }, true);
}
function refreshDiscover() {
  DC.cache.clear();
  if (!DC.view || DC.view.kind === 'detail') { if (DC.view) draw(); return; }
  go({ kind: 'home' }, true);
}

function initDiscoverSettings() {
  // torrent engine options
  const engine = $('#s-engine'), upload = $('#s-upload'), keep = $('#s-keepdata');
  engine.value = S.stremio.torrentEngine;
  upload.value = String(S.stremio.uploadKBs);
  keep.checked = S.stremio.keepData;
  let stremioHere = false;
  const syncEngineUi = () => {
    const e = S.stremio.torrentEngine;
    $('#builtin-opts').hidden = e === 'stremio' || (e === 'auto' && stremioHere);
    $('#stremio-srv-opts').hidden = e === 'builtin';
    $('#engine-note').textContent = e === 'auto'
      ? (stremioHere ? 'Stremio is installed on this PC, so torrents use its faster engine.' : "Stremio isn't installed here, so torrents use the built-in engine. Install Stremio for faster torrents.")
      : e === 'stremio' ? (stremioHere ? "Torrents use the Stremio app's engine." : "Stremio isn't installed on this PC, so torrents won't play with this setting.")
        : 'Torrents use the built-in engine (WebTorrent).';
  };
  api.stremioInstalled().then((v) => { stremioHere = v; syncEngineUi(); });
  const pushOpts = () => api.torrentOptions({ uploadKBs: S.stremio.uploadKBs, keepData: S.stremio.keepData });
  engine.addEventListener('change', () => { S.stremio.torrentEngine = engine.value; syncEngineUi(); save(); });
  upload.addEventListener('change', () => { S.stremio.uploadKBs = +upload.value; pushOpts(); save(); });
  keep.addEventListener('change', () => { S.stremio.keepData = keep.checked; pushOpts(); save(); });
  syncEngineUi();
  pushOpts();
  initAccountUi();
  const autoNext = $('#s-autonext');
  autoNext.checked = S.stremio.autoNext;
  autoNext.addEventListener('change', () => { S.stremio.autoNext = autoNext.checked; if (!autoNext.checked && typeof hideUpNext === 'function') hideUpNext(); save(); });

  const lang = $('#s-sublang');
  lang.value = S.stremio.subLang;
  lang.addEventListener('change', () => { S.stremio.subLang = lang.value; save(); });
  const srv = $('#s-server');
  srv.value = S.stremio.server;
  const check = async () => {
    const st = $('#srv-status');
    st.textContent = '· checking…';
    const ok = srv.value && (await api.stremioServer(srv.value.trim())).ok;
    st.textContent = ok ? '· running' : '· not running';
    st.style.color = ok ? '#3ddc84' : '';
  };
  srv.addEventListener('change', () => { S.stremio.server = srv.value.trim() || 'http://127.0.0.1:11470'; srv.value = S.stremio.server; save(); check(); });
  $$('.tab').forEach((t) => t.addEventListener('click', () => { if (t.dataset.tab === 'settings') check(); }));
  setTimeout(check, 3000);
}
