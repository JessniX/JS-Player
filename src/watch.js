// Watching a stream from Discover: the video fills the window and a Stremio-style bar floats
// over it (back + title on top, controls along the bottom). Both hide while the video plays
// and come back when the mouse moves. Local files keep the normal player layout.
(() => {
  const body = document.body;
  const stage = $('#stage');
  const menu = $('#w-menu');

  function sync() {
    // only on the Player screen: a stream left loaded while you browse Discover or Feeds doesn't count
    const on = !!(current?.remote && stage.classList.contains('has-video')) && !body.classList.contains('discover-mode') && !body.classList.contains('feeds-mode');
    body.classList.toggle('watch', on);
    if (on) {
      $('#w-title').textContent = current.item.title || current.item.name || '';
      showTime();
    } else hideMenu();
    bumpIdle();
  }
  new MutationObserver(sync).observe(stage, { attributes: true, attributeFilter: ['class'] });
  // switching screens (discover-mode / feeds-mode); watch's own toggle settles after one pass
  let lastMode = '';
  new MutationObserver(() => {
    const m = `${body.classList.contains('discover-mode')}${body.classList.contains('feeds-mode')}`;
    if (m !== lastMode) { lastMode = m; sync(); }
  }).observe(body, { attributes: true, attributeFilter: ['class'] });
  for (const ev of ['loadedmetadata', 'emptied']) video.addEventListener(ev, sync);

  // "12:04 / 53:21" next to the play button
  function showTime() {
    if (!body.classList.contains('watch')) return;
    const d = mediaDuration();
    $('#w-time').textContent = `${fmt(mediaTime())} / ${isFinite(d) && d ? fmt(d) : '--:--'}`;
  }
  for (const ev of ['timeupdate', 'durationchange', 'seeking']) video.addEventListener(ev, showTime);

  $('#w-back').onclick = () => leaveStream();

  // ⋮ menu: copy the links for this stream
  function links() {
    const it = current?.item || {};
    const out = [];
    const hash = it.torrent?.infoHash;
    if (hash) out.push(['magnet', 'Copy magnet link', /^magnet:/i.test(it.path) ? it.path : `magnet:?xt=urn:btih:${hash}`]);
    const stream = /^https?:/i.test(current?.probeUrl || '') ? current.probeUrl : /^https?:/i.test(it.path || '') ? it.path : '';
    if (stream) out.push(['stream', 'Copy stream link', stream]);
    return out;
  }
  function hideMenu() { menu.classList.add('hidden'); }
  function showMenu() {
    const items = links();
    menu.innerHTML = items.length
      ? items.map(([k, label]) => `<button role="menuitem" data-link="${k}">${escapeHtml(label)}</button>`).join('')
      : '<p class="dim small" style="margin:.4rem .6rem">No links for this stream.</p>';
    menu.classList.remove('hidden');
    const r = $('#w-more').getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, r.top - menu.offsetHeight - 8) + 'px';
    menu.querySelector('button')?.focus();
  }
  $('#w-more').onclick = () => (menu.classList.contains('hidden') ? showMenu() : hideMenu());
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-link]');
    if (!b) return;
    const hit = links().find(([k]) => k === b.dataset.link);
    hideMenu();
    if (!hit) return;
    try { await navigator.clipboard.writeText(hit[2]); }
    catch {
      const t = document.createElement('textarea');
      t.value = hit[2];
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    osd(hit[0] === 'magnet' ? 'Magnet link copied' : 'Stream link copied', 1600);
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#w-menu') && !e.target.closest('#w-more')) hideMenu();
  });
})();
