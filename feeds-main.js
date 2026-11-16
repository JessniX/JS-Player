// Feeds: social sites shown in sandboxed <webview>s that share one saved session.
// You sign in on each site's own page; Prism never sees or stores passwords.
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

// Some sites refuse to sign you in from an app that says "Electron" in its user agent.
function browserUserAgent() {
  return app.userAgentFallback.replace(/\s(Electron|prism-player)\/\S+/g, '');
}

function setupFeeds(getWin) {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(browserUserAgent());
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));

  app.on('web-contents-created', (_e, wc) => {
    // the Prism window may only attach locked-down https webviews in the feeds session
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
    return true;
  });
}

module.exports = { setupFeeds, PARTITION };
