// 小鹈鹕 V3 — Electron 壳
// 启动时后台拉起 gateway + 剪贴板监听器 + webui，然后弹窗加载 webui。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const isPackaged = app.isPackaged;
const V3 = isPackaged ? path.join(process.resourcesPath, 'content') : path.resolve(__dirname, '..'); // v3
const SERVER = path.join(V3, 'dashboard', 'server.mjs');
const WATCHER = path.join(V3, 'watch-clipboard.ps1');
const LOGO = path.join(V3, 'logo2.png');
const PORT = 18791;
const GW_PORT = 18789;
const OPENCLAW_ENTRY = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');

// 数据目录：打包后放用户可写目录；开发模式不设（脚本沿用现路径）。
if (isPackaged && !process.env.XIAOTIHU_DATA_DIR) {
  process.env.XIAOTIHU_DATA_DIR = path.join(process.env.APPDATA || '', 'xiaotihu');
}
if (isPackaged) {
  const dataDir = process.env.XIAOTIHU_DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  // 首次运行：把 config 模板拷到数据目录
  const cfgSrc = path.join(V3, 'config.json');
  const cfgDst = path.join(dataDir, 'config.json');
  if (fs.existsSync(cfgSrc) && !fs.existsSync(cfgDst)) {
    fs.copyFileSync(cfgSrc, cfgDst);
  }
}

const services = [];
let win = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findNode() {
  const cands = [];
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) cands.push(path.join(dir, 'node.exe'));
  }
  cands.push(
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
    'F:\\node.js\\node.exe'
  );
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'node';
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false)); // 端口被占用 = 服务已在线
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

function startService(cmd, args) {
  const c = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
  c.on('error', () => {});
  services.push(c);
  return c;
}

function watcherAlive() {
  const pidFile = path.join(V3, '.watcher.pid');
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0); // 存在则继续
    return true;
  } catch { return false; }
}

async function ensureServices() {
  const node = findNode();
  // gateway
  if (await portFree(GW_PORT)) {
    startService(node, [OPENCLAW_ENTRY, 'gateway', 'run']);
    await sleep(8000);
  }
  // webui
  if (await portFree(PORT)) {
    startService(node, [SERVER]);
    await sleep(2000);
  }
  // 监听器
  if (!watcherAlive()) {
    startService('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WATCHER]);
    await sleep(1000);
  }
}

app.whenReady().then(async () => {
  await ensureServices();

  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    icon: LOGO,
    title: '小鹈鹕',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = new BrowserWindow({ width: 1040, height: 760, icon: LOGO, autoHideMenuBar: true });
      win.loadURL(`http://127.0.0.1:${PORT}`);
    }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  for (const c of services) {
    try { c.kill(); } catch {}
  }
});
