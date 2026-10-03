const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');
const QRCode = require('qrcode');

process.on('uncaughtException', e => console.error(e)); // never let a stray error close the app
const gotLock = app.requestSingleInstanceLock(); // a second copy would fight over the port
if (!gotLock) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

const SERVER = path.join(__dirname, 'server.js').replace('app.asar', 'app.asar.unpacked');
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');

let win = null, child = null;
let status = 'stopped'; // 'stopped' | 'running' | 'paused'
let lastError = '';
let settings = { recent: [], port: 8000 };
let folder = '';

function load() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) }; } catch {}
  settings.recent = settings.recent.filter(p => fs.existsSync(p));
  folder = settings.recent[0] || '';
}
function save() { try { fs.writeFileSync(SETTINGS(), JSON.stringify(settings)); } catch {} }
function remember(p) { settings.recent = [p, ...settings.recent.filter(x => x !== p)].slice(0, 8); folder = p; save(); }

function lanUrls() {
  const rank = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  const ips = [];
  try {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  } catch {}
  ips.sort((a, b) => rank(a) - rank(b));
  return (ips.length ? ips : ['localhost']).map(ip => `http://${ip}:${settings.port}`);
}

async function state() {
  const urls = status === 'stopped' ? [] : lanUrls();
  let qr = '';
  try { if (urls.length) qr = await QRCode.toDataURL(urls[0], { margin: 1, width: 240 }); } catch {}
  return { status, folder, port: settings.port, recent: settings.recent, urls, qr, error: lastError };
}
async function push() { try { if (win && !win.isDestroyed()) win.webContents.send('state', await state()); } catch {} }

function launch(dir, port) {
  return new Promise((resolve, reject) => {
    let log = '';
    let timer = null;
    const c = fork(SERVER, [dir, '--port', String(port)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, silent: true });
    const grab = d => { log = (log + d).slice(-1000); };
    c.stdout.on('data', grab); c.stderr.on('data', grab);
    timer = setTimeout(() => c.kill(), 10000); // give up if the server never reports ready
    c.on('message', m => { if (m && m.type === 'ready') { clearTimeout(timer); child = c; status = 'running'; resolve(); } });
    c.on('exit', () => {
      clearTimeout(timer);
      if (child === c) { child = null; status = 'stopped'; push(); }
      else if (status === 'stopped') reject(new Error(/in use/.test(log) ? `Port ${port} is already in use. Choose another port.` : (log.trim().split('\n').pop() || 'The server could not start.')));
    });
  });
}

ipcMain.handle('state', state);
ipcMain.handle('pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a media folder' });
  if (!r.canceled && r.filePaths[0]) remember(r.filePaths[0]);
  return state();
});
ipcMain.handle('start', async (_e, o) => {
  if (child) return state();
  lastError = '';
  const port = Number(o && o.port);
  if (!o || !o.folder || !fs.existsSync(o.folder)) lastError = 'Choose a folder that exists.';
  else if (!Number.isInteger(port) || port < 1 || port > 65535) lastError = 'Enter a port between 1 and 65535.';
  else {
    settings.port = port; remember(o.folder);
    try { await launch(o.folder, port); } catch (e) { lastError = e.message; status = 'stopped'; }
  }
  return state();
});
ipcMain.handle('pause', () => { if (child && status === 'running') { child.send('pause'); status = 'paused'; } return state(); });
ipcMain.handle('resume', () => { if (child && status === 'paused') { child.send('resume'); status = 'running'; } return state(); });
ipcMain.handle('stop', () => { const c = child; child = null; status = 'stopped'; lastError = ''; if (c) c.kill(); return state(); });
ipcMain.handle('copy', (_e, t) => clipboard.writeText(String(t)));
ipcMain.handle('open', (_e, u) => { if (/^http:\/\//.test(u)) shell.openExternal(u); });

app.whenReady().then(() => {
  if (!gotLock) return;
  load();
  win = new BrowserWindow({
    width: 480, height: 840, minWidth: 400, backgroundColor: '#161220', autoHideMenuBar: true, title: 'Locally',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile('index.html');
});
app.on('before-quit', () => { if (child) child.kill(); });
app.on('window-all-closed', () => app.quit());
