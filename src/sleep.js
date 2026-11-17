// Sleep timer (stop after N minutes or at the end of this episode, fading the sound out first)
// and the keyboard shortcuts overlay (? or F1).
'use strict';

const SLEEP = { mode: null, until: 0, timer: null, fading: false };
const SLEEP_FADE = 30; // seconds of fade-out before stopping

function sleepLeft() {
  if (SLEEP.mode === 'time') return (SLEEP.until - Date.now()) / 1000;
  if (SLEEP.mode === 'end' && current) { const d = mediaDuration(); return isFinite(d) ? d - mediaTime() : Infinity; }
  return Infinity;
}
function setSleepGain(f) {
  if (actx && N.vol) N.vol.gain.setTargetAtTime(S.muted ? 0 : S.volume * f, actx.currentTime, 0.3);
}
function syncSleepUi() {
  const b = document.getElementById('b-sleep');
  if (!b) return;
  const tag = b.querySelector('.sleep-left');
  b.classList.toggle('on', !!SLEEP.mode);
  if (!SLEEP.mode) { tag.textContent = ''; b.title = 'Sleep timer (Z)'; return; }
  const left = sleepLeft();
  tag.textContent = SLEEP.mode === 'end' ? 'end' : left >= 60 ? Math.ceil(left / 60) + 'm' : Math.max(0, Math.ceil(left)) + 's';
  b.title = SLEEP.mode === 'end' ? 'Sleep timer: stops at the end of this video' : `Sleep timer: stops in ${Math.ceil(left / 60)} min`;
}
function setSleep(v) {
  clearInterval(SLEEP.timer);
  if (SLEEP.fading) applyAudio();
  Object.assign(SLEEP, { mode: null, until: 0, timer: null, fading: false });
  if (v === 'off' || v == null) { syncSleepUi(); return osd('Sleep timer off'); }
  if (v === 'end') {
    SLEEP.mode = 'end';
    if (typeof hideUpNext === 'function') hideUpNext(); // don't roll on into the next episode
    osd('🌙 Playback stops at the end of this video');
  } else {
    SLEEP.mode = 'time';
    SLEEP.until = Date.now() + v * 60000;
    S.sleep.last = v;
    save();
    osd(`🌙 Sleep timer: ${v} min`);
  }
  SLEEP.timer = setInterval(sleepTick, 1000);
  syncSleepUi();
}
function sleepTick() {
  syncSleepUi();
  if (!SLEEP.mode || video.paused) return;
  const left = sleepLeft();
  if (left <= SLEEP_FADE) { SLEEP.fading = true; setSleepGain(Math.max(0, left / SLEEP_FADE)); }
  if (SLEEP.mode === 'time' && left <= 0) sleepStop();
}
function sleepStop() {
  clearInterval(SLEEP.timer);
  Object.assign(SLEEP, { mode: null, until: 0, timer: null });
  video.pause();
  if (current?.remote) leaveStream('🌙 Sleep timer: playback stopped. Good night!'); // also stops the torrent and Stremio's engine
  else osd('🌙 Sleep timer: playback stopped. Good night!', 4000);
  setTimeout(() => { SLEEP.fading = false; applyAudio(); }, 400); // full volume again for next time
  syncSleepUi();
}
const sleepEndsHere = () => SLEEP.mode === 'end';
function sleepOnEnded() {
  if (SLEEP.mode !== 'end') return false;
  sleepStop();
  return true;
}

function showSleepMenu() {
  let menu = document.getElementById('sleep-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'sleep-menu';
    menu.className = 'pop hidden';
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sleep]');
      if (!b) return;
      menu.classList.add('hidden');
      const v = b.dataset.sleep;
      setSleep(v === 'off' || v === 'end' ? v : +v);
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#sleep-menu') && !e.target.closest('#b-sleep')) menu.classList.add('hidden');
    });
  }
  const opt = (v, label) => `<button role="menuitem" data-sleep="${v}" class="${(v === 'end' && SLEEP.mode === 'end') ? 'on' : ''}">${label}</button>`;
  menu.innerHTML = `<div class="pop-head">🌙 Sleep timer</div>`
    + (SLEEP.mode ? opt('off', 'Turn off') : '')
    + opt('end', 'At the end of this video')
    + [15, 30, 45, 60, 90].map((m) => opt(m, `${m} minutes${m === S.sleep.last ? ' <span class="dim small">· last used</span>' : ''}`)).join('');
  const b = document.getElementById('b-sleep').getBoundingClientRect();
  menu.classList.remove('hidden');
  menu.style.left = Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, b.left - 60)) + 'px';
  menu.style.top = Math.max(8, b.top - menu.offsetHeight - 8) + 'px';
  menu.querySelector('button')?.focus();
}

// ---------------------------------------------------------------- keyboard shortcuts overlay
const KEY_HELP = [
  ['Playback', [['Space / K', 'Play or pause'], ['N / P', 'Next / previous'], ['] / [', 'Faster / slower'], ['Backspace', 'Normal speed'], ['L', 'A-B repeat'], [', / .', 'Frame back / forward (paused)']]],
  ['Seeking', [['← / →', 'Back / forward (Shift: 1 s, Ctrl: 1 min)'], ['0 – 9', 'Jump to 0% – 90%']]],
  ['Sound', [['↑ / ↓', 'Volume'], ['M', 'Mute']]],
  ['Subtitles', [['C', 'Subtitles on / off'], ['Shift + C', 'Next subtitles'], ['G / H', 'Earlier / later by 0.1 s (Shift: 1 s)'], ['Alt + + / −', 'Bigger / smaller']]],
  ['View', [['F / Enter', 'Full screen'], ['Tab', 'Show / hide the side panel'], ['V', 'Next visualizer'], ['S', 'Screenshot'], ['Z', 'Sleep timer'], ['? / F1', 'This list']]],
  ['Images', [['← / →', 'Previous / next image'], ['Wheel / + / −', 'Zoom'], ['0 / 1', 'Fit / 100%'], ['R / Shift + R', 'Rotate'], ['H', 'Flip'], ['Space', 'Slideshow'], ['I', 'Image info'], ['T', 'Filmstrip']]],
  ['Files', [['Ctrl + O', 'Open files'], ['Ctrl + Shift + O', 'Open a folder']]],
  ['Streams', [['Esc', 'Cancel a stream that is loading / cancel Up next'], ['Esc (Discover)', 'Go back']]],
  ['TV & gamepad', [['Arrows / D-pad', 'Move around'], ['Enter / A', 'Select'], ['Esc / B', 'Back']]],
];
function showShortcuts() {
  let el = document.getElementById('keys-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'keys-overlay';
    el.className = 'keys-overlay hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Keyboard shortcuts');
    el.innerHTML = `<div class="keys-card">
      <div class="keys-head"><h2>⌨ Keyboard shortcuts</h2><button class="icon-btn" data-keys-close title="Close (Esc)" aria-label="Close">${icon('x')}</button></div>
      <div class="keys-grid">${KEY_HELP.map(([g, rows]) => `<section><h3>${g}</h3>${rows.map(([k, d]) =>
        `<div class="keys-row"><span class="keys-k">${k.split(' / ').map((x) => `<kbd>${escapeHtml(x)}</kbd>`).join('<span class="dim">/</span>')}</span><span>${escapeHtml(d)}</span></div>`).join('')}</section>`).join('')}</div>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('[data-keys-close]')) hideShortcuts(); });
  }
  el.classList.remove('hidden');
  el.querySelector('[data-keys-close]').focus();
}
function hideShortcuts() { document.getElementById('keys-overlay')?.classList.add('hidden'); }
const shortcutsShown = () => !!document.querySelector('#keys-overlay:not(.hidden)');

COMMANDS.sleep = showSleepMenu;
COMMANDS.shortcuts = showShortcuts;
document.getElementById('b-sleep')?.addEventListener('click', showSleepMenu);
