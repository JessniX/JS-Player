// Renders build/icon.svg into the app icons: build/icon.png (512), build/icon.ico (16–256)
// and src/logo.png (the in-app logo, 128 px). Run with: npx electron build/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// a Windows .ico holding PNG images
function makeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const sizes = [...ICO_SIZES, 512];
  const urls = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    await img.decode();
    // draw big once, then step down by halves for clean small sizes
    const big = document.createElement('canvas');
    big.width = big.height = 1024;
    big.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
    const out = {};
    for (const s of ${JSON.stringify(sizes)}) {
      let src = big;
      while (src.width / 2 >= s) {
        const c = document.createElement('canvas');
        c.width = c.height = src.width / 2;
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, 0, 0, c.width, c.height);
        src = c;
      }
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, s, s);
      out[s] = c.toDataURL('image/png');
    }
    return out;
  })()`);
  const png = (s) => Buffer.from(urls[s].split(',')[1], 'base64');
  fs.writeFileSync(path.join(__dirname, 'icon.png'), png(512));
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), makeIco(ICO_SIZES.map((size) => ({ size, data: png(size) }))));
  fs.writeFileSync(path.join(__dirname, '..', 'src', 'logo.png'), png(128));
  console.log('icons written');
  app.quit();
});
