// Feeds: social sites shown in sandboxed <webview>s that share one saved session.
// You sign in on each site's own page; JS Player never sees or stores passwords.
// It only checks which login cookies exist, to show "Signed in" on the Feeds screen.

const { app, session, ipcMain } = require('electron');

const PARTITION = 'persist:feeds';

// cookie names that only exist when you're signed in
const SIGNED_IN_COOKIES = {
  youtube: [['youtube.com', ['SAPISID', '__Secure-3PAPISID', 'LOGIN_INFO']]],
  tiktok: [['tiktok.com', ['sessionid', 'sessionid_ss']]],
  instagram: [['instagram.com', ['sessionid']]],
  facebook: [['facebook.com', ['c_user']]],
  x: [['x.com', ['auth_token']]],
  reddit: [['reddit.com', ['reddit_session']]],
};
// what "Sign out" clears
const SIGN_OUT_DOMAINS = {
  youtube: ['youtube.com', 'google.com'],
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
  facebook: ['facebook.com'],
  x: ['x.com', 'twitter.com'],
  reddit: ['reddit.com'],
};

// Present exactly like desktop Chrome on the same engine version. Sites treat unknown
// browsers (an "Electron" or app-name token, or no "Google Chrome" brand) as second-class:
// some refuse sign-in, some serve lower video quality.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
function browserUserAgent() {
  const platform = (/\(([^)]+)\)/.exec(app.userAgentFallback) || [])[1] || 'Windows NT 10.0; Win64; x64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
}
const CH_BRANDS = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`;
const CH_FULL = `"Google Chrome";v="${process.versions.chrome}", "Chromium";v="${process.versions.chrome}", "Not_A Brand";v="24.0.0.0"`;
// Sign-in data saved by older versions of JS Player can make X's sign-in fail. If you're not
// signed in to X, clear X's saved data once (there's nothing to lose).
async function resetStaleXOnce(ses) {
  const flag = require('path').join(app.getPath('userData'), 'feeds-x-reset-1.flag');
  const fs = require('fs');
  if (fs.existsSync(flag)) return;
  try {
    const cookies = await ses.cookies.get({ domain: 'x.com' });
    if (!cookies.some((c) => c.name === 'auth_token' && c.value)) await clearSiteData(ses, SIGN_OUT_DOMAINS.x);
    fs.writeFileSync(flag, String(Date.now()));
  } catch { /* try again next start */ }
}
async function clearSiteData(ses, domains) {
  for (const domain of domains) {
    const cookies = await ses.cookies.get({ domain }).catch(() => []);
    for (const c of cookies) {
      const host = c.domain.replace(/^\./, '');
      await ses.cookies.remove(`https://${host}${c.path || '/'}`, c.name).catch(() => {});
    }
    for (const origin of [`https://${domain}`, `https://www.${domain}`]) {
      await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch(() => {});
    }
  }
}

function setupFeeds(getWin) {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(browserUserAgent());
  // Only where it matters (YouTube quality, Google sign-in): every hooked request takes a
  // detour through the main process, which measurably slowed request-heavy sites like TikTok.
  const CH_FILTER = { urls: ['*://*.youtube.com/*', '*://*.google.com/*', '*://*.googlevideo.com/*'] };
  ses.webRequest.onBeforeSendHeaders(CH_FILTER, (details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) {
      const lk = k.toLowerCase();
      if (lk === 'sec-ch-ua') h[k] = CH_BRANDS;
      else if (lk === 'sec-ch-ua-full-version-list') h[k] = CH_FULL;
    }
    cb({ requestHeaders: h });
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));
  resetStaleXOnce(ses);

  app.on('web-contents-created', (_e, wc) => {
    // the JS Player window may only attach locked-down https webviews in the feeds session
    if (wc.getType() === 'window') {
      wc.on('will-attach-webview', (e, prefs, params) => {
        delete prefs.preload;
        prefs.nodeIntegration = false;
        prefs.contextIsolation = true;
        prefs.sandbox = true;
        if (!/^https:\/\//.test(params.src || '') || params.partition !== PARTITION) e.preventDefault();
      });
    }
    // sign-in popups ("Continue with Google", etc.) open as small windows in the same session
    if (wc.getType() === 'webview') {
      // Esc inside a feed page never reaches the JS Player window, so pass it on (used to leave full screen)
      wc.on('before-input-event', (_e, input) => {
        const w = getWin();
        if (input.type === 'keyDown' && input.key === 'Escape' && w && !w.isDestroyed()) w.webContents.send('feed-escape');
      });
      wc.setWindowOpenHandler(({ url }) => {
        if (!/^https?:\/\//.test(url)) return { action: 'deny' };
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: getWin() || undefined, width: 520, height: 720, autoHideMenuBar: true, title: 'Sign in',
            webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      });
    }
  });

  // ---- custom sites: icons and clearing sign-ins
  const ICON_MAX = 400 * 1024;
  const toDataUrl = (buf, type) => `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
  async function fetchImage(url) {
    const res = await ses.fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > ICON_MAX) return null;
    const guessed = /^image\//.test(type) ? type : /\.svg(\?|$)/i.test(url) ? 'image/svg+xml' : /\.ico(\?|$)/i.test(url) ? 'image/x-icon' : /\.png(\?|$)/i.test(url) ? 'image/png' : null;
    return guessed ? toDataUrl(buf, guessed) : null;
  }
  // The site's own icon: prefer apple-touch-icon / the biggest <link rel=icon>, then /favicon.ico.
  ipcMain.handle('feeds-fetch-icon', async (_e, pageUrl) => {
    try {
      const page = new URL(pageUrl);
      if (page.protocol !== 'https:') return null;
      const candidates = [];
      try {
        const res = await ses.fetch(page.href, { signal: AbortSignal.timeout(8000) });
        const html = (await res.text()).slice(0, 400000);
        for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
          const tag = m[0];
          const rel = (/rel=["']?([^"'>]+)/i.exec(tag) || [])[1] || '';
          const href = (/href=["']?([^"' >]+)/i.exec(tag) || [])[1];
          if (!href || !/icon/i.test(rel)) continue;
          const size = parseInt((/sizes=["']?(\d+)/i.exec(tag) || [])[1] || (/apple-touch/i.test(rel) ? '180' : '16'), 10);
          candidates.push({ url: new URL(href, res.url || page.href).href, size });
        }
      } catch { /* page didn't load; try /favicon.ico */ }
      candidates.sort((a, b) => b.size - a.size);
      candidates.push({ url: new URL('/favicon.ico', page.origin).href, size: 0 });
      for (const c of candidates.slice(0, 5)) {
        try { const d = await fetchImage(c.url); if (d) return d; } catch { /* next */ }
      }
      return null;
    } catch { return null; }
  });
  ipcMain.handle('read-image-dataurl', async (_e, file) => {
    try {
      const ext = (file.split('.').pop() || '').toLowerCase();
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ico: 'image/x-icon' }[ext];
      if (!type) return { error: 'Use a PNG, JPG, WebP, GIF, SVG or ICO image' };
      const buf = await require('fs').promises.readFile(file);
      if (buf.length > ICON_MAX) return { error: 'That image is too big for an icon (max 400 KB)' };
      return { data: toDataUrl(buf, type) };
    } catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('feeds-clear-site', async (_e, siteUrl) => {
    try {
      const host = new URL(siteUrl).hostname.replace(/^www\./, '');
      const cookies = await ses.cookies.get({ domain: host }).catch(() => []);
      for (const c of cookies) await ses.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path || '/'}`, c.name).catch(() => {});
      for (const origin of [`https://${host}`, `https://www.${host}`]) {
        await ses.clearStorageData({ origin, storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch(() => {});
      }
      return true;
    } catch { return false; }
  });

  ipcMain.handle('feeds-status', async () => {
    const out = {};
    for (const [id, rules] of Object.entries(SIGNED_IN_COOKIES)) {
      out[id] = false;
      for (const [domain, names] of rules) {
        const cookies = await ses.cookies.get({ domain }).catch(() => []);
        if (cookies.some((c) => names.includes(c.name) && c.value)) out[id] = true;
      }
    }
    return out;
  });

  ipcMain.handle('feeds-sign-out', async (_e, id) => {
    const domains = SIGN_OUT_DOMAINS[id];
    if (!domains) return false;
    await clearSiteData(ses, domains);
    return true;
  });
}

module.exports = { setupFeeds, PARTITION };
