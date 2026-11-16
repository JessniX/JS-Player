// Live audio visualizer. Reads an AnalyserNode and draws one of several modes to a canvas.

const VIZ_MODES = [
  { id: 'bars', name: 'Bars' },
  { id: 'mirror', name: 'Mirror' },
  { id: 'silk', name: 'Silk' },
  { id: 'wave', name: 'Scope' },
  { id: 'radial', name: 'Halo' },
  { id: 'nebula', name: 'Nebula' },
  { id: 'waterfall', name: 'Waterfall' },
  { id: 'off', name: 'Off' },
];

const VIZ_PALETTES = {
  rainbow: ['#ff3b3b', '#ffb21e', '#f6ff3b', '#3bff7a', '#3bd8ff', '#6b5bff', '#ff3bd4'],
  fire: ['#5a0000', '#d12a00', '#ff7b00', '#ffd23f', '#fffbe0'],
  ice: ['#0b1d4f', '#1f5fbf', '#38bdf8', '#a5f3fc', '#ffffff'],
};

class Visualizer {
  constructor(canvas, stage) {
    this.c = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.opts = { mode: 'bars', bars: 96, sensitivity: 1, glow: 12, peaks: true, pulse: true, colorMode: 'theme', custom: ['#7c6cff', '#29d3c2', '#ff3cac'] };
    this.peaks = [];
    this.levels = [];
    this.particles = [];
    this.bass = 0;
    this.stops = ['#7c6cff', '#29d3c2'];
    this.rgbStops = [];
    this.coverEl = null;
    this.visible = true;
    this.fall = document.createElement('canvas');
    this.fctx = this.fall.getContext('2d');
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  attach(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
    this.binMap = null;
  }

  setOptions(o) {
    const modeChanged = o.mode && o.mode !== this.opts.mode;
    Object.assign(this.opts, o);
    if (o.bars) this.binMap = null;
    if (modeChanged) { this.ctx.clearRect(0, 0, this.W, this.H); this.particles = []; this.fctx.clearRect(0, 0, this.fall.width, this.fall.height); }
    this.refreshColors();
  }

  refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--accent').trim() || '#7c6cff';
    const accent2 = cs.getPropertyValue('--accent2').trim() || '#29d3c2';
    const m = this.opts.colorMode;
    this.stops = m === 'custom' ? this.opts.custom : VIZ_PALETTES[m] || [accent, accent2];
    this.rgbStops = this.stops.map(hexToRgb);
    this.glowColor = this.stops[Math.floor(this.stops.length / 2)];
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.W = Math.max(1, Math.round(this.c.clientWidth * dpr));
    this.H = Math.max(1, Math.round(this.c.clientHeight * dpr));
    if (this.c.width !== this.W || this.c.height !== this.H) {
      this.c.width = this.W;
      this.c.height = this.H;
      this.fall.width = this.W;
      this.fall.height = this.H;
    }
  }

  colorAt(t, a = 1) {
    const s = this.rgbStops;
    if (!s.length) return `rgba(255,255,255,${a})`;
    t = Math.min(1, Math.max(0, t)) * (s.length - 1);
    const i = Math.min(s.length - 2, Math.floor(t));
    const f = s.length === 1 ? 0 : t - i;
    const c0 = s[i], c1 = s[Math.min(s.length - 1, i + 1)];
    return `rgba(${Math.round(c0[0] + (c1[0] - c0[0]) * f)},${Math.round(c0[1] + (c1[1] - c0[1]) * f)},${Math.round(c0[2] + (c1[2] - c0[2]) * f)},${a})`;
  }

  gradient(x0, y0, x1, y1, a = 1) {
    const g = this.ctx.createLinearGradient(x0, y0, x1, y1);
    this.stops.forEach((_, i) => g.addColorStop(i / Math.max(1, this.stops.length - 1), this.colorAt(i / Math.max(1, this.stops.length - 1), a)));
    return g;
  }

  // Log-spaced frequency bands, 0..1
  bands(n) {
    const a = this.analyser;
    if (!this.binMap || this.binMap.length !== n) {
      const binHz = a.context.sampleRate / a.fftSize;
      const fmin = 32, fmax = 16000;
      this.binMap = [];
      for (let i = 0; i < n; i++) {
        const f0 = fmin * Math.pow(fmax / fmin, i / n);
        const f1 = fmin * Math.pow(fmax / fmin, (i + 1) / n);
        const b0 = Math.max(1, Math.floor(f0 / binHz));
        const b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
        this.binMap.push([b0, Math.min(b1, this.freq.length)]);
      }
      this.levels = new Float32Array(n);
      this.peaks = new Float32Array(n);
    }
    const sens = this.opts.sensitivity;
    for (let i = 0; i < n; i++) {
      const [b0, b1] = this.binMap[i];
      let m = 0;
      for (let b = b0; b < b1; b++) if (this.freq[b] > m) m = this.freq[b];
      let v = m / 255;
      v = Math.pow(v, 1.7) * sens * (1 + (i / n) * 0.45);
      v = Math.min(1, v);
      // fast attack, slower release
      this.levels[i] = v > this.levels[i] ? v : this.levels[i] * 0.86 + v * 0.14;
      this.peaks[i] = Math.max(this.levels[i], this.peaks[i] - 0.007);
    }
    return this.levels;
  }

  loop() {
    requestAnimationFrame(this.loop);
    if (!this.analyser || !this.visible || this.opts.mode === 'off') return;
    if (!this.c.clientWidth || !this.c.clientHeight) return; // canvas hidden (e.g. behind a video)
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.time);

    // bass energy (≈ 20–160 Hz)
    const binHz = this.analyser.context.sampleRate / this.analyser.fftSize;
    let sum = 0, cnt = 0;
    for (let b = 1; b * binHz < 160; b++) { sum += this.freq[b]; cnt++; }
    const bass = cnt ? Math.pow(sum / cnt / 255, 2) * this.opts.sensitivity : 0;
    this.bass = bass > this.bass ? bass : this.bass * 0.9 + bass * 0.1;
    this.stage.style.setProperty('--pulse', this.opts.pulse ? this.bass.toFixed(3) : 0);

    const ctx = this.ctx;
    ctx.save();
    ctx.shadowBlur = this.opts.glow * this.dpr;
    ctx.shadowColor = this.glowColor;
    const m = this.opts.mode;
    if (m !== 'nebula' && m !== 'waterfall') ctx.clearRect(0, 0, this.W, this.H);
    this['draw_' + m] && this['draw_' + m]();
    ctx.restore();
  }

  draw_bars() {
    const { ctx, W, H } = this;
    const n = this.opts.bars;
    const v = this.bands(n);
    const slot = W / n, w = Math.max(1, slot * 0.72);
    const base = H * 0.97, maxH = H * 0.82;
    ctx.fillStyle = this.gradient(0, 0, W, 0);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const h = Math.max(2 * this.dpr, v[i] * maxH);
      ctx.roundRect(i * slot + (slot - w) / 2, base - h, w, h, [Math.min(w / 2, 4 * this.dpr), Math.min(w / 2, 4 * this.dpr), 0, 0]);
    }
    ctx.fill();
    if (this.opts.peaks) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = this.colorAt(1, 0.9);
      for (let i = 0; i < n; i++) ctx.fillRect(i * slot + (slot - w) / 2, base - this.peaks[i] * maxH - 4 * this.dpr, w, 2 * this.dpr);
    }
    // reflection
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = this.gradient(0, 0, W, 0);
    for (let i = 0; i < n; i++) ctx.fillRect(i * slot + (slot - w) / 2, base + 2 * this.dpr, w, v[i] * (H - base) * 0.9);
  }

  draw_mirror() {
    const { ctx, W, H } = this;
    const n = this.opts.bars;
    const v = this.bands(n);
    const slot = W / n, w = Math.max(1, slot * 0.6), mid = H / 2, maxH = H * 0.44;
    ctx.fillStyle = this.gradient(0, 0, W, 0);
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const h = Math.max(1.5 * this.dpr, v[i] * maxH);
      ctx.roundRect(i * slot + (slot - w) / 2, mid - h, w, h * 2, w / 2);
    }
    ctx.fill();
  }

  draw_silk() {
    const { ctx, W, H } = this;
    const n = Math.max(32, Math.floor(this.opts.bars / 2));
    const v = this.bands(n);
    const base = H * 0.98;
    for (let layer = 2; layer >= 0; layer--) {
      const k = 1 - layer * 0.22;
      ctx.beginPath();
      ctx.moveTo(0, base);
      let px = 0, py = base - v[0] * H * 0.8 * k;
      ctx.lineTo(px, py);
      for (let i = 1; i < n; i++) {
        const x = (i / (n - 1)) * W, y = base - v[i] * H * 0.8 * k;
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        px = x; py = y;
      }
      ctx.lineTo(W, py);
      ctx.lineTo(W, base);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, H * 0.1, 0, base);
      g.addColorStop(0, this.colorAt(layer / 2, 0.85 - layer * 0.25));
      g.addColorStop(1, this.colorAt(1 - layer / 2, 0.05));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = this.colorAt(layer / 2, 0.9);
      ctx.lineWidth = 2 * this.dpr;
      ctx.stroke();
    }
  }

  draw_wave() {
    const { ctx, W, H, time } = this;
    const sens = this.opts.sensitivity;
    const draw = (amp, alpha, width) => {
      ctx.beginPath();
      const step = Math.max(1, Math.floor(time.length / W * 2));
      for (let i = 0, x = 0; i < time.length; i += step) {
        x = (i / time.length) * W;
        const y = H / 2 + ((time[i] - 128) / 128) * H * 0.42 * amp * sens;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = this.gradient(0, 0, W, 0, alpha);
      ctx.lineWidth = width * this.dpr;
      ctx.lineJoin = 'round';
      ctx.stroke();
    };
    draw(-0.6, 0.25, 6);
    draw(1, 1, 2.5);
  }

  draw_radial() {
    const { ctx, W, H } = this;
    const n = Math.max(32, Math.floor(this.opts.bars / 2));
    const v = this.bands(n);
    let cx = W / 2, cy = H / 2, r0 = Math.min(W, H) * 0.17;
    const cover = this.coverEl;
    if (cover && cover.offsetParent && cover.clientWidth) {
      const cr = cover.getBoundingClientRect(), sr = this.c.getBoundingClientRect();
      cx = (cr.left + cr.width / 2 - sr.left) * this.dpr;
      cy = (cr.top + cr.height / 2 - sr.top) * this.dpr;
      r0 = (cr.width / 2 + 10) * this.dpr;
    }
    r0 *= 1 + this.bass * 0.08;
    const maxL = Math.min(W, H) * 0.28;
    const total = n * 2;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, (Math.PI * 2 * r0) / total * 0.55);
    for (let j = 0; j < total; j++) {
      const i = j < n ? j : total - 1 - j; // mirror for symmetry
      const a = (j / total) * Math.PI * 2 - Math.PI / 2;
      const len = 3 * this.dpr + v[i] * maxL;
      ctx.strokeStyle = this.colorAt(i / n);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, r0 - 4 * this.dpr), 0, Math.PI * 2);
    ctx.strokeStyle = this.colorAt(0.5, 0.5);
    ctx.lineWidth = 2 * this.dpr;
    ctx.stroke();
  }

  draw_nebula() {
    const { ctx, W, H } = this;
    // fade previous frame (keeps transparency)
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const n = 64;
    const v = this.bands(n);
    let cx = W / 2, cy = H / 2, coverR = 0;
    const cover = this.coverEl;
    if (cover && cover.offsetParent && cover.clientWidth) {
      const cr = cover.getBoundingClientRect(), sr = this.c.getBoundingClientRect();
      cx = (cr.left + cr.width / 2 - sr.left) * this.dpr;
      cy = (cr.top + cr.height / 2 - sr.top) * this.dpr;
      coverR = (Math.hypot(cr.width, cr.height) / 2) * this.dpr;
    }
    const spawn = 2 + Math.floor(this.bass * 14);
    for (let k = 0; k < spawn && this.particles.length < 900; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (1 + Math.random() * 3 + this.bass * 9) * this.dpr;
      this.particles.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, t: Math.random(), s: (1 + Math.random() * 2.2) * this.dpr });
    }
    const boost = 1 + this.bass * 0.6;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * boost; p.y += p.vy * boost;
      p.life -= 0.008;
      if (p.life <= 0 || p.x < 0 || p.x > W || p.y < 0 || p.y > H) { this.particles.splice(i, 1); continue; }
      ctx.fillStyle = this.colorAt(p.t, p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.s, 0, Math.PI * 2);
      ctx.fill();
    }
    // spectrum ring
    const r0 = Math.max(coverR + 6 * this.dpr, Math.min(W, H) * 0.12) * (1 + this.bass * 0.3);
    ctx.beginPath();
    for (let j = 0; j <= n * 2; j++) {
      const i = j < n ? j : Math.max(0, n * 2 - 1 - j);
      const a = (j / (n * 2)) * Math.PI * 2;
      const r = r0 + v[i] * Math.min(W, H) * 0.16;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = this.gradient(cx - r0, cy - r0, cx + r0, cy + r0);
    ctx.lineWidth = 2.5 * this.dpr;
    ctx.stroke();
  }

  draw_waterfall() {
    const { ctx, W, H, fctx, fall } = this;
    const n = 128;
    const v = this.bands(n);
    const colW = Math.max(2, Math.round(2 * this.dpr));
    // scroll left, then paint the newest column at the right edge
    fctx.globalCompositeOperation = 'copy';
    fctx.drawImage(fall, -colW, 0);
    fctx.globalCompositeOperation = 'source-over';
    const rowH = H / n;
    for (let i = 0; i < n; i++) {
      const val = v[i];
      if (val < 0.02) continue;
      fctx.fillStyle = this.colorAt(val, Math.min(1, val * 1.4));
      fctx.fillRect(W - colW, H - (i + 1) * rowH, colW, rowH + 1);
    }
    ctx.shadowBlur = 0;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(fall, 0, 0);
  }
}
