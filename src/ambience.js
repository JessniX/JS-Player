// Makes the player react to what is playing:
//  - album-art colour tints the stage and side-panel edge while music with real cover art plays
//  - the play button and progress bar follow the bass (the visualizer's --pulse value)
//  - a slow wave drifts behind the empty screen when nothing is loaded
// Everything here is decoration on top of real state; it all stops under "reduce motion".
(() => {
  const html = document.documentElement;
  const body = document.body;
  const cover = document.getElementById('cover');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  // ---------------------------------------------------------- album-art colour
  // Pick the most vivid hue family in a small sample of the cover, then keep it light enough to read as colour.
  function artColor(img) {
    const n = 32;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, n, n);
    const px = ctx.getImageData(0, 0, n, n).data;
    const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max ? (max - min) / max : 0;
      const val = max / 255;
      if (sat < 0.2 || val < 0.18) continue; // skip greys and near-black
      let h;
      if (max === r) h = ((g - b) / (max - min)) % 6;
      else if (max === g) h = (b - r) / (max - min) + 2;
      else h = (r - g) / (max - min) + 4;
      const k = buckets[Math.floor(((h * 60 + 360) % 360) / 30)];
      const w = sat * sat * val;
      k.w += w; k.r += r * w; k.g += g * w; k.b += b * w;
    }
    const best = buckets.reduce((a, k) => (k.w > a.w ? k : a));
    if (best.w < 2) return null; // greyscale art: keep the theme colour
    let rgb = [best.r / best.w, best.g / best.w, best.b / best.w];
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    if (lum < 0.45) { const f = 0.45 / Math.max(lum, 0.05); rgb = rgb.map((v) => Math.min(255, v * f)); }
    return rgb.map(Math.round);
  }

  cover.addEventListener('load', () => {
    const real = cover.src && !cover.src.startsWith('data:');
    let rgb = null;
    if (real) { try { rgb = artColor(cover); } catch { /* unreadable image */ } }
    if (rgb) html.style.setProperty('--ambient-rgb', rgb.join(','));
    else html.style.removeProperty('--ambient-rgb');
    body.classList.toggle('art-tint', !!rgb);
  });

  // ---------------------------------------------------------- bass reaction
  // --pulse only updates while the visualizer draws (music, or video with the overlay on), so the
  // controls react only then; otherwise a stale value would freeze them mid-beat.
  const media = document.getElementById('media');
  const stage = document.getElementById('stage');
  function syncLive() {
    const vizDrawing = !stage.classList.contains('has-video') || stage.classList.contains('viz-on-video');
    const live = !media.paused && !media.ended && vizDrawing;
    body.classList.toggle('pulse-live', live);
    body.classList.toggle('audio-playing', live && !stage.classList.contains('has-video'));
    if (!live) html.style.setProperty('--pulse', 0);
  }
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata']) media.addEventListener(ev, syncLive);
  new MutationObserver(syncLive).observe(stage, { attributes: true, attributeFilter: ['class'] });

  // ---------------------------------------------------------- idle wave
  const empty = document.getElementById('empty');
  const wave = document.createElement('canvas');
  wave.id = 'idle-wave';
  wave.setAttribute('aria-hidden', 'true');
  empty.prepend(wave);
  const wctx = wave.getContext('2d');
  let running = false, colors = null, colorAge = 0;

  function readColors() {
    const cs = getComputedStyle(html);
    return [cs.getPropertyValue('--accent-rgb').trim(), cs.getPropertyValue('--accent2-rgb').trim()];
  }
  function draw(t) {
    const dpr = devicePixelRatio || 1;
    const W = Math.round(wave.clientWidth * dpr), H = Math.round(wave.clientHeight * dpr);
    if (!W || !H) return;
    if (wave.width !== W || wave.height !== H) { wave.width = W; wave.height = H; }
    if (!colors || ++colorAge > 90) { colors = readColors(); colorAge = 0; }
    wctx.clearRect(0, 0, W, H);
    const s = t / 1000;
    const lines = [
      { c: colors[0], a: 0.45, amp: 0.050, len: 1.2, speed: 0.22, y: 0.80, w: 2.2 },
      { c: colors[0], a: 0.24, amp: 0.070, len: 0.8, speed: -0.14, y: 0.84, w: 1.6 },
      { c: colors[1], a: 0.16, amp: 0.040, len: 1.9, speed: 0.31, y: 0.87, w: 1.2 },
    ];
    for (const l of lines) {
      wctx.beginPath();
      for (let x = 0; x <= W; x += 6 * dpr) {
        const p = x / W;
        const env = Math.sin(Math.PI * p); // fade the wave out at both edges
        const y = H * l.y + Math.sin(p * Math.PI * 2 * l.len + s * l.speed * Math.PI * 2) * H * l.amp * env
          + Math.sin(p * Math.PI * 5 + s * 0.4) * H * 0.012 * env;
        x ? wctx.lineTo(x, y) : wctx.moveTo(x, y);
      }
      const g = wctx.createLinearGradient(0, 0, W, 0); // fade out toward both edges
      g.addColorStop(0, `rgba(${l.c}, 0)`);
      g.addColorStop(0.5, `rgba(${l.c}, ${l.a})`);
      g.addColorStop(1, `rgba(${l.c}, 0)`);
      wctx.strokeStyle = g;
      wctx.lineWidth = l.w * dpr;
      wctx.stroke();
    }
  }
  function frame(t) {
    if (!running) return;
    draw(t);
    requestAnimationFrame(frame);
  }
  function syncWave() {
    const show = !empty.classList.contains('hidden') && !document.hidden && body.classList.contains('feeds-mode') === false;
    colors = null;
    if (reduceMotion.matches) { running = false; if (show) draw(4000); return; } // one still frame
    if (show && !running) { running = true; requestAnimationFrame(frame); }
    if (!show) running = false;
  }
  new MutationObserver(syncWave).observe(empty, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(syncWave).observe(body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', syncWave);
  reduceMotion.addEventListener('change', syncWave);
  syncWave();
})();
