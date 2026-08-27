// 小鹈鹕 V3 — Electron 壳
// 启动时后台拉起核心服务（core/index.js）；核心以退出码 42 退出时自动重启（微信登录/登出热重启）。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const isPackaged = app.isPackaged;
const V3 = isPackaged ? path.join(process.resourcesPath, 'content') : path.resolve(__dirname, '..'); // v3
const CORE = path.join(V3, 'core', 'index.js');
const LOGO = path.join(V3, 'logo2.png');
const PORT = 18791;
const RESTART_EXIT_CODE = 42;

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

let coreProc = null;
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

function startCore(node) {
  coreProc = spawn(node, [CORE], { stdio: 'ignore', windowsHide: true });
  coreProc.on('error', () => {});
  coreProc.on('exit', (code) => {
    if (code === RESTART_EXIT_CODE) {
      startCore(node); // 微信登录/登出后的热重启
    }
  });
  return coreProc;
}

app.whenReady().then(async () => {
  const node = findNode();
  if (await portFree(PORT)) {
    startCore(node);
    await sleep(3000);
  }

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    icon: LOGO,
    title: '小鹈鹕',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = new BrowserWindow({ width: 1280, height: 800, minWidth: 760, minHeight: 560, icon: LOGO, autoHideMenuBar: true });
      win.loadURL(`http://127.0.0.1:${PORT}`);
    }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  if (coreProc) {
    try { coreProc.kill(); } catch {}
  }
});
