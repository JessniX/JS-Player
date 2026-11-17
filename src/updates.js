// Updates: the Settings > Updates section and the "Update ready" notice.
// The checking and downloading happens in updater-main.js.

const UPD = { state: null, toastHiddenFor: null };

function renderUpdate(s) {
  UPD.state = s;
  $('#upd-version').textContent = s.current || '';
  const status = $('#upd-status');
  const bar = $('#upd-bar');
  const install = $('#upd-install');
  const check = $('#upd-check');
  bar.classList.add('hidden');
  install.classList.add('hidden');
  check.disabled = false;
  const text = {
    dev: 'Updates work in the installed app.',
    idle: 'Not checked yet.',
    checking: 'Checking for updates…',
    latest: "You're up to date.",
    downloading: `Downloading version ${s.version || ''}… ${s.percent || 0}%`,
    ready: `Version ${s.version} is ready to install.`,
    error: `Couldn't check for updates: ${s.message || 'unknown error'}`,
  }[s.state] || '';
  status.textContent = text;
  if (s.state === 'checking' || s.state === 'downloading') check.disabled = true;
  if (s.state === 'downloading') {
    bar.classList.remove('hidden');
    $('#upd-fill').style.width = (s.percent || 0) + '%';
  }
  if (s.state === 'ready') {
    install.classList.remove('hidden');
    check.disabled = true;
    if (UPD.toastHiddenFor !== s.version) {
      $('#ut-title').textContent = `JS Player ${s.version} is ready`;
      $('#update-toast').classList.remove('hidden');
    }
  }
  if (s.state === 'dev') check.disabled = true;
}

async function checkForUpdatesNow() {
  renderUpdate({ ...(UPD.state || {}), state: 'checking' });
  renderUpdate(await api.updateCheck());
}

async function installUpdateNow() {
  const ok = await api.updateInstall();
  if (!ok) osd('No update is ready yet');
}

function initUpdates() {
  bindCheck('#s-autoupdate', () => S.updates.auto, (v) => { S.updates.auto = v; });
  $('#upd-check').onclick = checkForUpdatesNow;
  $('#upd-install').onclick = installUpdateNow;
  $('#ut-restart').onclick = installUpdateNow;
  $('#ut-later').onclick = () => {
    UPD.toastHiddenFor = UPD.state?.version;
    $('#update-toast').classList.add('hidden');
    osd('The update will install the next time you close JS Player', 2600);
  };
  api.onUpdateStatus(renderUpdate);
  api.updateGet().then(renderUpdate);
}
