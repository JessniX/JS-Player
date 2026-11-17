// TV mode: a big-screen ("10-foot") interface. Everything is larger and full screen, Discover is
// the home screen, and it works without a mouse: arrow keys (TV remotes send these), Enter, Back/Esc,
// or a gamepad (D-pad/stick to move, A choose, B back, Start play/pause, LB/RB skip 10 s).

const TV = { on: false, raf: 0, prev: [], held: null, heldSince: 0, lastRepeat: 0 };
const TV_ZOOM = 1.5;

function setTvMode(on, quiet) {
  TV.on = !!on;
  S.tvMode = TV.on;
  save();
  document.body.classList.toggle('tv', TV.on);
  api.windowCmd('zoom', TV.on ? TV_ZOOM : 1);
  api.windowCmd('fullscreen', TV.on || fs);
  $$('.tv-btn').forEach((b) => {
    b.classList.toggle('on', TV.on);
    const label = b.querySelector('span');
    if (label) label.textContent = TV.on ? 'Exit TV' : 'TV';
    b.title = TV.on ? 'Leave TV mode' : 'TV mode: big screen, remote and gamepad friendly';
  });
  const box = $('#s-tv');
  if (box) box.checked = TV.on;
  if (TV.on) {
    // Discover is the TV home screen, unless something is playing right now
    if (FD.mode === 'player' && (!current || video.paused)) setMode('discover');
    startGamepad();
    if (!quiet) osd('TV mode: use the arrows or a gamepad to move, Enter to choose, Back or Esc to go back', 4500);
    setTimeout(focusFirst, 300);
  } else {
    stopGamepad();
    if (!quiet) osd('TV mode off');
  }
}
COMMANDS['tv-mode'] = () => setTvMode(!TV.on);

// ------------------------------------------------------------ moving the highlight
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';
function navRoot() {
  const dlg = document.querySelector('dialog[open]');
  if (dlg) return dlg;
  if (FD.mode === 'discover') return $('#discover').closest('#app') || document;
  return document;
}
function isShown(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  if (el.closest('[hidden], .hidden')) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && el.offsetParent !== null;
}
const navTargets = () => [...navRoot().querySelectorAll(FOCUSABLE)].filter(isShown);
function focusEl(el) {
  el.focus({ preventScroll: true });
  // keep the highlighted row in the middle of the screen, like TV apps do
  el.scrollIntoView({ block: el.matches('.dc-card, .dc-ep') ? 'center' : 'nearest', inline: 'nearest', behavior: 'smooth' });
}
function focusFirst(tries = 0) {
  if (!TV.on) return;
  const list = navTargets();
  // prefer the first poster, stream or episode; posters may still be loading, so wait a little for them
  const pick = list.find((el) => el.matches('.dc-card:not(.skeleton), .dc-stream, .dc-ep, .feed-card button'));
  if (pick) return focusEl(pick);
  if (tries < 10 && FD.mode !== 'player') return setTimeout(() => focusFirst(tries + 1), 400);
  if (list[0] && (document.activeElement === document.body || !document.activeElement)) focusEl(list[0]);
}
function moveFocus(dir) {
  const list = navTargets();
  if (!list.length) return;
  const cur = document.activeElement;
  if (!cur || cur === document.body || !list.includes(cur)) return focusFirst();
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
    let main, side;
    if (dir === 'left') { if (b.right > a.left + 2) continue; main = -dx; side = Math.abs(dy); }
    else if (dir === 'right') { if (b.left < a.right - 2) continue; main = dx; side = Math.abs(dy); }
    else if (dir === 'up') { if (b.bottom > a.top + 2) continue; main = -dy; side = Math.abs(dx); }
    else { if (b.top < a.bottom - 2) continue; main = dy; side = Math.abs(dx); }
    const score = main + side * 2.5; // stay in the same row/column when possible
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) focusEl(best);
}

// ------------------------------------------------------------ Back
function tvBack() {
  const dlg = document.querySelector('dialog[open]');
  if (dlg) { dlg.close(); return; }
  if (!$('#subs-menu').classList.contains('hidden')) { hideSubsMenu(); return; }
  if (FD.mode === 'player') {
    if (current?.remote) { leaveStream(); return; }
    if (!video.paused) video.pause();
    setMode('discover');
    setTimeout(focusFirst, 200);
    return;
  }
  if (FD.mode === 'discover') {
    if (DC.stack.length) { discoverBack(); setTimeout(focusFirst, 250); }
    return;
  }
  if (FD.mode === 'feeds') { if (!FD.onHome) showFeedHome(); else setMode('discover'); setTimeout(focusFirst, 200); }
}

// ------------------------------------------------------------ keys (runs before the normal shortcuts)
window.addEventListener('keydown', (e) => {
  if (!TV.on || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  const typing = (t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type)) || t.tagName === 'TEXTAREA';
  const k = e.key;
  const dirs = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  let handled = false;

  if (k === 'Escape' || k === 'BrowserBack' || k === 'GoBack' || (k === 'Backspace' && !typing)) { tvBack(); handled = true; }
  else if (FD.mode === 'player' && !document.querySelector('dialog[open]') && (document.activeElement === document.body || document.activeElement === video)) {
    // watching: arrows seek/volume (the normal shortcuts); Enter plays/pauses
    if (k === 'Enter') { togglePlay(); handled = true; }
  } else if (dirs[k]) {
    if (typing && (k === 'ArrowLeft' || k === 'ArrowRight')) return; // move the text cursor
    if (t.tagName === 'SELECT' && (k === 'ArrowUp' || k === 'ArrowDown')) return; // change the option
    moveFocus(dirs[k]);
    handled = true;
  } else if (k === 'Enter' && !e.isTrusted && document.activeElement && document.activeElement !== document.body) {
    document.activeElement.click(); // gamepad "A" (real Enter presses already click buttons)
    handled = true;
  }
  if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

// ------------------------------------------------------------ gamepad
const pressKey = (key) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const PAD = { 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight', 0: 'Enter', 1: 'Escape' };
function padDirection(p) {
  const x = p.axes[0] || 0, y = p.axes[1] || 0;
  if (Math.abs(x) < 0.6 && Math.abs(y) < 0.6) return null;
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'ArrowRight' : 'ArrowLeft') : (y > 0 ? 'ArrowDown' : 'ArrowUp');
}
function pollGamepad() {
  TV.raf = requestAnimationFrame(pollGamepad);
  const pad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean);
  if (!pad) return;
  const now = performance.now();
  const pressed = pad.buttons.map((b) => b.pressed);
  const edge = (i) => pressed[i] && !TV.prev[i];
  for (const i of [0, 1]) if (edge(i)) pressKey(PAD[i]);
  if (edge(9)) togglePlay(); // Start
  if (edge(4) && FD.mode === 'player') seekBy(-10); // LB
  if (edge(5) && FD.mode === 'player') seekBy(10); // RB
  // D-pad and stick move the highlight; holding repeats
  const dir = [12, 13, 14, 15].map((i) => (pressed[i] ? PAD[i] : null)).find(Boolean) || padDirection(pad);
  if (dir !== TV.held) {
    TV.held = dir;
    TV.heldSince = now;
    TV.lastRepeat = now;
    if (dir) pressKey(dir);
  } else if (dir && now - TV.heldSince > 450 && now - TV.lastRepeat > 140) {
    TV.lastRepeat = now;
    pressKey(dir);
  }
  TV.prev = pressed;
}
function startGamepad() { if (!TV.raf) TV.raf = requestAnimationFrame(pollGamepad); }
function stopGamepad() { cancelAnimationFrame(TV.raf); TV.raf = 0; TV.prev = []; TV.held = null; }
window.addEventListener('gamepadconnected', (e) => {
  osd(`Gamepad connected${TV.on ? '' : '. Turn on TV mode to use it'}`, 2500);
});

function initTv() {
  const box = $('#s-tv');
  if (box) box.addEventListener('change', () => setTvMode(box.checked));
  if (S.tvMode) setTvMode(true, true);
}
