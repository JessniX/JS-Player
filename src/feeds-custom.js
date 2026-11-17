// Customize Feeds: show/hide and reorder feeds, and add your own websites with custom icons.
// Saved in S.feeds.custom (your sites), S.feeds.order and S.feeds.hidden.

const FC = { editing: null, icon: '' };
const feedsDlg = $('#feeds-dialog');
hydrateIcons(feedsDlg); // the dialog comes after app.js in the page, so draw its icons here

function openFeedsDialog(editId) {
  renderFeedsList();
  resetFeedForm();
  if (editId) startEditFeed(editId);
  if (!feedsDlg.open) feedsDlg.showModal();
}

function saveFeedsAndRefresh() {
  save();
  renderFeedRail();
  renderFeedCards();
  renderFeedsList();
  if (FD.current && FD.mode === 'feeds' && !FD.onHome) updateFeedBar();
}

function renderFeedsList() {
  const list = allFeeds();
  $('#fc-list').innerHTML = list.map((f, i) => {
    const hidden = isHidden(f.id);
    return `<li class="${hidden ? 'is-hidden' : ''}" data-id="${f.id}">
      <div class="fc-icon small ${f.icon ? 'has-img' : ''}" style="background:${f.color}">${feedIcon(f)}</div>
      <div class="fc-li-text"><b>${escapeHtml(f.name)}</b><span class="dim small">${f.custom ? escapeHtml(hostOf(f.home)) : 'Built in'}${hidden ? ' · hidden' : ''}</span></div>
      <button class="icon-btn" data-act="up" title="Move up" aria-label="Move ${escapeHtml(f.name)} up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button class="icon-btn" data-act="down" title="Move down" aria-label="Move ${escapeHtml(f.name)} down" ${i === list.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
      <button class="icon-btn" data-act="toggle" title="${hidden ? 'Show' : 'Hide'}" aria-label="${hidden ? 'Show' : 'Hide'} ${escapeHtml(f.name)}">${icon(hidden ? 'eyeOff' : 'eye')}</button>
      ${f.custom ? `<button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit ${escapeHtml(f.name)}">${icon('edit')}</button>
      <button class="icon-btn" data-act="remove" title="Remove" aria-label="Remove ${escapeHtml(f.name)}">${icon('trash')}</button>` : `<span class="icon-btn fc-li-pad" aria-hidden="true">${icon('edit')}</span><span class="icon-btn fc-li-pad" aria-hidden="true">${icon('trash')}</span>`}
    </li>`;
  }).join('');
}

$('#fc-list').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.closest('li').dataset.id;
  const act = b.dataset.act;
  if (act === 'up' || act === 'down') {
    const ids = allFeeds().map((f) => f.id);
    const i = ids.indexOf(id), j = i + (act === 'up' ? -1 : 1);
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    S.feeds.order = ids;
    saveFeedsAndRefresh();
    $(`#fc-list li[data-id="${id}"] button[data-act="${act}"]`)?.focus();
  } else if (act === 'toggle') {
    const hidden = new Set(S.feeds.hidden || []);
    hidden.has(id) ? hidden.delete(id) : hidden.add(id);
    S.feeds.hidden = [...hidden];
    if (hidden.has(id) && FD.current === id && FD.mode === 'feeds') showFeedHome();
    saveFeedsAndRefresh();
  } else if (act === 'edit') {
    startEditFeed(id);
  } else if (act === 'remove') {
    const f = feedById(id);
    if (!confirm(`Remove ${f.name} from your feeds?`)) return;
    S.feeds.custom = (S.feeds.custom || []).filter((c) => c.id !== id);
    S.feeds.order = (S.feeds.order || []).filter((x) => x !== id);
    S.feeds.hidden = (S.feeds.hidden || []).filter((x) => x !== id);
    closeFeedView(id);
    if (FC.editing === id) resetFeedForm();
    saveFeedsAndRefresh();
    osd(`Removed ${f.name}`);
  }
});

// ------------------------------------------------------------ add / edit form
function setFormMsg(text, bad) {
  const m = $('#fc-msg');
  m.textContent = text || '';
  m.style.color = bad ? '#ff6b6b' : 'var(--dim)';
}
function updatePreview() {
  const f = { id: 'preview', name: $('#fc-name').value || '?', glyph: $('#fc-glyph').value.trim(), icon: FC.icon, color: $('#fc-color').value };
  const p = $('#fc-prev-icon');
  p.style.background = f.color;
  p.classList.toggle('has-img', !!f.icon);
  p.innerHTML = feedIcon(f);
}
function resetFeedForm() {
  FC.editing = null;
  FC.icon = '';
  $('#fc-form').reset();
  $('#fc-color').value = '#7c4dff';
  $('#fc-form-title').textContent = 'Add a website';
  $('#fc-save').textContent = 'Add site';
  $('#fc-cancel').hidden = true;
  setFormMsg('');
  updatePreview();
}
function startEditFeed(id) {
  const c = (S.feeds.custom || []).find((x) => x.id === id);
  if (!c) return;
  FC.editing = id;
  FC.icon = c.icon || '';
  $('#fc-name').value = c.name;
  $('#fc-url').value = c.home;
  $('#fc-glyph').value = c.glyph || '';
  $('#fc-color').value = safeColor(c.color);
  $('#fc-auto').checked = !!c.auto;
  $('#fc-form-title').textContent = `Edit ${c.name}`;
  $('#fc-save').textContent = 'Save changes';
  $('#fc-cancel').hidden = false;
  setFormMsg('');
  updatePreview();
  $('#fc-name').focus();
}
// "example.com" -> "https://example.com/"; only https pages can open in Feeds.
function normalizeSiteUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return { error: 'Type the web address of the site.' };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  let url;
  try { url = new URL(u); } catch { return { error: "That doesn't look like a web address." }; }
  if (url.protocol === 'http:') return { error: 'Only secure (https://) sites can be added.' };
  if (url.protocol !== 'https:' || !url.hostname.includes('.')) return { error: "That doesn't look like a web address." };
  return { url: url.href };
}

['input', 'change'].forEach((ev) => {
  $('#fc-name').addEventListener(ev, updatePreview);
  $('#fc-glyph').addEventListener(ev, () => { if ($('#fc-glyph').value.trim()) FC.icon = ''; updatePreview(); });
  $('#fc-color').addEventListener(ev, updatePreview);
});
$('#fc-icon-site').onclick = async () => {
  const n = normalizeSiteUrl($('#fc-url').value);
  if (n.error) return setFormMsg(n.error, true);
  setFormMsg('Getting the icon…');
  const data = await api.feedsFetchIcon(n.url);
  if (!data) return setFormMsg("Couldn't get an icon from that site. Choose an image or type an emoji instead.", true);
  FC.icon = data;
  $('#fc-glyph').value = '';
  if (!$('#fc-name').value.trim()) $('#fc-name').value = hostOf(n.url).split('.')[0].replace(/^./, (c) => c.toUpperCase());
  setFormMsg('Got the site\'s icon.');
  updatePreview();
};
$('#fc-icon-file').onclick = async () => {
  const p = await api.pickImage();
  if (!p) return;
  const r = await api.readImageDataUrl(p);
  if (r.error) return setFormMsg(r.error, true);
  FC.icon = r.data;
  $('#fc-glyph').value = '';
  setFormMsg('Image set as the icon.');
  updatePreview();
};
$('#fc-cancel').onclick = resetFeedForm;

$('#fc-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#fc-name').value.trim();
  const n = normalizeSiteUrl($('#fc-url').value);
  if (!name) return setFormMsg('Give the site a name.', true);
  if (n.error) return setFormMsg(n.error, true);
  const entry = {
    name: name.slice(0, 40), home: n.url, color: safeColor($('#fc-color').value), auto: $('#fc-auto').checked,
    glyph: $('#fc-glyph').value.trim().slice(0, 4), icon: FC.icon || '',
  };
  S.feeds.custom = S.feeds.custom || [];
  if (FC.editing) {
    const c = S.feeds.custom.find((x) => x.id === FC.editing);
    const urlChanged = c && c.home !== entry.home;
    Object.assign(c, entry);
    if (urlChanged) closeFeedView(c.id);
    else { const wv = FD.views.get(c.id); if (wv) { try { injectAutoNext(wv, feedById(c.id)); } catch {} } }
    osd(`Saved ${entry.name}`);
  } else {
    const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    S.feeds.custom.push({ id, ...entry });
    osd(`Added ${entry.name} to your feeds`);
  }
  resetFeedForm();
  saveFeedsAndRefresh();
});

// close on the X, or on a click outside the dialog box (the dimmed backdrop)
function closeOnBackdrop(d) {
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return d.close();
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
}
closeOnBackdrop(feedsDlg);
COMMANDS['customize-feeds'] = () => openFeedsDialog();
