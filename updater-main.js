// Auto-update: checks the JS-Player GitHub releases, downloads new versions in the
// background, then lets you restart into them (or installs them when you quit).
// Only runs in the installed app. During development it reports "dev" instead.

const { app, ipcMain } = require('electron');

const FIRST_CHECK_MS = 8000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000; // every 4 hours while the app is open

function setupUpdater({ getWin, isAutoEnabled }) {
  let state = { state: 'idle', current: app.getVersion() };
  const send = (patch) => {
    state = { ...state, ...patch, current: app.getVersion() };
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send('update-status', state);
  };

  // A test feed can be set with PRISM_UPDATE_URL (a folder with latest.yml and the installer).
  const testFeed = process.env.PRISM_UPDATE_URL;
  if (!app.isPackaged && !testFeed) {
    ipcMain.handle('update-get', () => ({ state: 'dev', current: app.getVersion() }));
    ipcMain.handle('update-check', () => ({ state: 'dev', current: app.getVersion() }));
    ipcMain.handle('update-install', () => false);
    return;
  }

  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) {
    ipcMain.handle('update-get', () => ({ state: 'error', message: 'Updater not available', current: app.getVersion() }));
    ipcMain.handle('update-check', () => ({ state: 'error', message: 'Updater not available', current: app.getVersion() }));
    ipcMain.handle('update-install', () => false);
    return;
  }
  if (testFeed) autoUpdater.setFeedURL({ provider: 'generic', url: testFeed });
  autoUpdater.autoDownload = true;
  // Never install from a test feed or a self-test run: that would really install it on this PC.
  autoUpdater.autoInstallOnAppQuit = !testFeed && !process.argv.includes('--smoke');
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  let manual = false;
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => { send({ state: 'latest', checkedAt: Date.now() }); manual = false; });
  autoUpdater.on('update-available', (info) => send({ state: 'downloading', version: info.version, percent: 0, notes: info.releaseNotes || '' }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    // No internet or no update info published yet: report quietly, try again later.
    const msg = String(err && err.message || err);
    const friendly = /ENOTFOUND|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(msg) ? "Couldn't reach GitHub. Check your internet connection."
      : /latest\.yml|404|Cannot find/i.test(msg) ? 'No update information published yet.'
      : msg.split('\n')[0].slice(0, 160);
    send({ state: 'error', message: friendly, manual });
    manual = false;
  });

  const check = (isManual) => {
    manual = !!isManual;
    if (state.state === 'downloading' || state.state === 'ready') return Promise.resolve(state);
    return autoUpdater.checkForUpdates().then(() => state).catch(() => state);
  };

  ipcMain.handle('update-get', () => state);
  ipcMain.handle('update-check', () => check(true));
  ipcMain.handle('update-install', () => {
    if (state.state !== 'ready') return false;
    setImmediate(() => autoUpdater.quitAndInstall(false, true)); // install, then reopen JS Player
    return true;
  });

  setTimeout(() => { if (isAutoEnabled()) check(false); }, FIRST_CHECK_MS);
  setInterval(() => { if (isAutoEnabled()) check(false); }, CHECK_EVERY_MS);
}

module.exports = { setupUpdater };
