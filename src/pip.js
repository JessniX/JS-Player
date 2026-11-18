// Miniplayer (picture-in-picture) with subtitles.
// The browser's miniplayer only shows a video element's own picture, so subtitles drawn on the page
// never reach it. Instead (the approach Seanime uses), each frame of the video and the current
// subtitles are drawn onto a canvas, and the miniplayer shows that canvas. Sound keeps coming from
// the main player; the miniplayer's play/pause and the media keys control it as before.
// Subtitles use the same look as the main player (Plus Jakarta Sans, white with a dark outline).
(() => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const mirror = document.createElement('video'); // shows the canvas in the miniplayer
  mirror.muted = true;
  mirror.playsInline = true;
  let timer = null, syncing = false;

  function size() {
    // the video's own shape, capped at 1280 wide so drawing stays cheap
    const w = video.videoWidth || 1280, h = video.videoHeight || 720;
    const k = Math.min(1, 1280 / w);
    const cw = Math.round(w * k), ch = Math.round(h * k);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  }

  // the subtitle lines showing now, with italics if the cue is in <i>
  function subLines() {
    const t = SUBS.track;
    if (SUBS.hidden || !t || !t.activeCues) return [];
    const out = [];
    for (const c of t.activeCues) {
      const italic = /<i>/i.test(c.text);
      for (const line of c.text.replace(/<[^>]+>/g, '').split('\n')) if (line.trim()) out.push({ text: line, italic });
    }
    return out;
  }

  function draw() {
    if (video.readyState < 2) return;
    size();
    const W = canvas.width, H = canvas.height;
    ctx.drawImage(video, 0, 0, W, H);
    const lines = subLines();
    if (!lines.length) return;
    // bigger than in the main player (relative to the picture), since the miniplayer is small
    const px = Math.round(H * 0.09 * (((S.sub && S.sub.size) || 100) / 100));
    const lh = px * 1.35;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    let y = H - H * 0.06 - (lines.length - 1) * lh;
    for (const l of lines) {
      ctx.font = `${l.italic ? 'italic ' : ''}400 ${px}px PlusJakartaSans, Arial, sans-serif`;
      ctx.lineWidth = Math.max(2, px * 0.16);
      ctx.strokeStyle = 'rgba(0,0,0,.9)';
      ctx.strokeText(l.text, W / 2, y);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--sub-color').trim() || '#fff';
      ctx.fillText(l.text, W / 2, y);
      y += lh;
    }
  }

  async function openMini() {
    size();
    draw();
    if (!mirror.srcObject) mirror.srcObject = canvas.captureStream(30);
    await mirror.play();
    clearInterval(timer);
    timer = setInterval(draw, 33);
    await mirror.requestPictureInPicture();
    if (video.paused) mirror.pause();
  }
  function closeMini() {
    clearInterval(timer);
    timer = null;
  }
  mirror.addEventListener('leavepictureinpicture', closeMini);

  // keep the miniplayer's play/pause button in step with the main player (and the other way round)
  video.addEventListener('pause', () => { if (document.pictureInPictureElement === mirror && !mirror.paused) { syncing = true; mirror.pause(); syncing = false; } });
  video.addEventListener('play', () => { if (document.pictureInPictureElement === mirror && mirror.paused) { syncing = true; mirror.play().catch(() => {}); syncing = false; } });
  mirror.addEventListener('pause', () => { if (!syncing && document.pictureInPictureElement === mirror && !video.paused) video.pause(); });
  mirror.addEventListener('play', () => { if (!syncing && document.pictureInPictureElement === mirror && video.paused) video.play().catch(() => {}); });
  // the video stopped (stream closed, another file): close the miniplayer
  video.addEventListener('emptied', () => { if (document.pictureInPictureElement === mirror) document.exitPictureInPicture().catch(() => {}); });

  window.toggleMiniPlayer = async () => {
    if (!stage.classList.contains('has-video')) return osd('Picture-in-picture needs a video');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await openMini();
    } catch (e) {
      closeMini();
      // the canvas can't be used (e.g. a video from another site): fall back to the plain miniplayer
      try { await video.requestPictureInPicture(); } catch (e2) { showError(e2.message || e.message); }
    }
  };
})();
