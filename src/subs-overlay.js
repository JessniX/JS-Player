// Subtitles drawn by JS Player instead of the browser, styled exactly like Stremio's player
// (from Stremio's open-source stremio-video / stremio-web, MIT):
//   - font: Plus Jakarta Sans, normal weight; white text, no background box
//   - an 8-way 0.15rem black text-shadow as the outline
//   - size: floor(size / 25) vmin (4vmin at 100%), sizes 75/100/125/150/175/200/250
//   - each cue on its own line, 0.2em padding, the subtitle's own line breaks kept
//   - the block sits 5% above the bottom of the player, raised by the control bar's height while it shows
// The text track still does the timing (delay, live-conversion offset); this only draws its active cues.
(() => {
  const stage = $('#stage');
  const box = document.createElement('div');
  box.id = 'sub-overlay';
  stage.append(box);
  let shownKey = '';

  // Stremio's default has no background box; the old JS Player default (black at 55%) becomes that once
  if (S.sub && S.sub.bg === '#000000' && S.sub.bga === 0.55) { S.sub.bga = 0; applySubStyle(); save(); }

  function render() {
    const t = SUBS.track;
    if (t && t.mode === 'showing') t.mode = 'hidden'; // keep the timing, stop the browser drawing them
    const cues = !SUBS.hidden && t && t.activeCues && stage.classList.contains('has-video') ? [...t.activeCues] : [];
    const key = cues.map((c) => c.startTime + c.text).join('|');
    if (key !== shownKey) {
      shownKey = key;
      const nodes = [];
      for (const c of cues) {
        const cue = document.createElement('span');
        cue.className = 'sub-cue';
        cue.append(c.getCueAsHTML()); // cue markup (<i>, <b>) as safe DOM, never raw HTML
        nodes.push(cue, document.createElement('br'));
      }
      box.replaceChildren(...nodes);
    }
    box.hidden = !cues.length;
    if (cues.length) place();
  }

  function place() {
    // Stremio's floor(size / 25) vmin, scaled up to the size measured in Stremio's desktop app (40px at a
    // 897px-tall window against the formula's 35.9px)
    box.style.fontSize = (Math.floor(((S.sub && S.sub.size) || 100) / 25) * 1.115).toFixed(3) + 'vmin';
    // 5% from the bottom of the player, or above the control bar while it's showing (as Stremio does)
    let pct = 5;
    const body = document.body;
    if (body.classList.contains('watch') && !body.classList.contains('idle')) {
      const h = stage.getBoundingClientRect().height;
      if (h > 0) pct = Math.max(pct, Math.ceil(($('#controls').getBoundingClientRect().height / h) * 100));
    }
    box.style.bottom = pct + '%';
  }

  setInterval(render, 100);
  for (const ev of ['seeked', 'pause', 'play']) video.addEventListener(ev, render);
  window.addEventListener('resize', render);
  new MutationObserver(render).observe(document.body, { attributes: true, attributeFilter: ['class'] }); // controls show/hide
})();
