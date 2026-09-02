// 小鹈鹕 TinyPelican — Electron 壳
// 启动时后台拉起核心服务（core/index.js）；核心以退出码 42 退出时自动重启（微信登录/登出热重启）。
// 同时创建两个无边框浮窗：右下角建议小图标 + 点击后弹出的建议卡片。
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

app.disableHardwareAcceleration();

const isPackaged = app.isPackaged;
const PROJECT_ROOT = isPackaged ? path.join(process.resourcesPath, 'content') : path.resolve(__dirname, '..');
const CORE = path.join(PROJECT_ROOT, 'core', 'index.js');
const LOGO = path.join(PROJECT_ROOT, 'logo2.png');
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
  const cfgSrc = path.join(PROJECT_ROOT, 'config.json');
  const cfgDst = path.join(dataDir, 'config.json');
  if (fs.existsSync(cfgSrc) && !fs.existsSync(cfgDst)) {
    fs.copyFileSync(cfgSrc, cfgDst);
  }
}

let coreProc = null;
let win = null;
let iconWin = null;
let cardWin = null;
let suggestionPollTimer = null;
let currentAnchor = null;
let lastSuggestionId = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findNode() {
  const cands = [];
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) cands.push(path.join(dir, 'node.exe'));
  }
  const customNode = process.env.XIAOTIHU_NODE;
  if (customNode) cands.push(customNode);
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const root = process.env[name];
    if (root) cands.push(path.join(root, 'nodejs', 'node.exe'));
  }
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function positionAtScreenCorner() {
  if (!iconWin || !cardWin || iconWin.isDestroyed() || cardWin.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  iconWin.setPosition(area.x + area.width - 68, area.y + area.height - 68);
  cardWin.setPosition(area.x + area.width - 340, area.y + area.height - 68 - 290);
}

function positionFloatingWindows(anchor = currentAnchor) {
  if (!iconWin || !cardWin || iconWin.isDestroyed() || cardWin.isDestroyed()) return;

  if (!anchor || !Number.isFinite(Number(anchor.x)) || !Number.isFinite(Number(anchor.y))) {
    positionAtScreenCorner();
    return;
  }

  const anchorX = Number(anchor.x);
  const anchorY = Number(anchor.y);
  const iconWidth = 48;
  const iconHeight = 48;
  const cardWidth = 340;
  const cardHeight = 300;

  // 用锚点找最近的显示器，并限制在该显示器工作区内，防止微信位于副屏/屏幕边缘时窗口越界。
  const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY });
  const area = display.workArea;

  const iconX = clamp(Math.round(anchorX - iconWidth / 2), area.x, area.x + area.width - iconWidth);
  const iconY = clamp(Math.round(anchorY - iconHeight / 2), area.y, area.y + area.height - iconHeight);
  const cardX = clamp(Math.round(anchorX - cardWidth + iconWidth / 2), area.x, area.x + area.width - cardWidth);
  const cardY = clamp(Math.round(anchorY - cardHeight - 12), area.y, area.y + area.height - cardHeight);

  iconWin.setPosition(iconX, iconY);
  cardWin.setPosition(cardX, cardY);
}

async function refreshCurrentAnchor() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/reply-suggestions/current/refresh-position`, { method: 'POST' });
    if (!res.ok) return 'error';
    const data = await res.json();
    const s = data && data.suggestion;
    if (!s) return 'none';
    const anchor = s.anchor && Number.isFinite(Number(s.anchor.x)) && Number.isFinite(Number(s.anchor.y))
      ? { x: Number(s.anchor.x), y: Number(s.anchor.y) }
      : null;
    if (s.id !== lastSuggestionId) lastSuggestionId = s.id;
    currentAnchor = anchor;
    positionFloatingWindows(currentAnchor);
    return 'ok';
  } catch {
    return 'error';
  }
}

async function showCard() {
  if (!cardWin || cardWin.isDestroyed()) return;
  // 点击图标时按服务端保存的句柄重新读窗口矩形，窗口移动后卡片仍跟随微信。
  const state = await refreshCurrentAnchor();
  if (state === 'none') {
    lastSuggestionId = null;
    currentAnchor = null;
    hideAllSuggestions();
    return;
  }
  positionFloatingWindows(currentAnchor);
  if (!cardWin.isVisible()) cardWin.show();
  cardWin.webContents.send('suggestion:card-opened');
}

function hideCard() {
  if (cardWin && !cardWin.isDestroyed() && cardWin.isVisible()) cardWin.hide();
}

function hideAllSuggestions() {
  hideCard();
  if (iconWin && !iconWin.isDestroyed() && iconWin.isVisible()) iconWin.hide();
}

function createFloatingWindows() {
  const preload = path.join(__dirname, 'preload.js');

  iconWin = new BrowserWindow({
    width: 48,
    height: 48,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload }
  });
  iconWin.loadURL(`http://127.0.0.1:${PORT}/suggestion-icon.html`);
  iconWin.setBackgroundColor('#00000000');
  if (typeof iconWin.setHasShadow === 'function') iconWin.setHasShadow(false);
  iconWin.setAlwaysOnTop(true, 'screen-saver');

  cardWin = new BrowserWindow({
    width: 340,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload }
  });
  cardWin.loadURL(`http://127.0.0.1:${PORT}/suggestion-card.html`);
  cardWin.setBackgroundColor('#00000000');
  if (typeof cardWin.setHasShadow === 'function') cardWin.setHasShadow(false);
  cardWin.setAlwaysOnTop(true, 'screen-saver');

  positionFloatingWindows();
}

async function pollSuggestions() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/reply-suggestions/current`);
    if (!res.ok) return;
    const data = await res.json();
    const s = data && data.suggestion;
    if (s && iconWin && !iconWin.isDestroyed()) {
      const anchor = s.anchor && Number.isFinite(Number(s.anchor.x)) && Number.isFinite(Number(s.anchor.y))
        ? { x: Number(s.anchor.x), y: Number(s.anchor.y) }
        : null;
      // 只在建议 ID 变化时重新定位，避免每 800ms 重复 setPosition()。
      if (s.id !== lastSuggestionId) {
        lastSuggestionId = s.id;
        currentAnchor = anchor;
        positionFloatingWindows(currentAnchor);
      }
      if (!iconWin.isVisible()) iconWin.showInactive();
    } else {
      lastSuggestionId = null;
      currentAnchor = null;
      hideAllSuggestions();
    }
  } catch {}
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

  createFloatingWindows();

  ipcMain.on('suggestion:show-card', () => showCard());
  ipcMain.on('suggestion:hide-card', () => hideCard());
  ipcMain.on('suggestion:apply-done', () => hideAllSuggestions());

  suggestionPollTimer = setInterval(pollSuggestions, 800);
  pollSuggestions();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = new BrowserWindow({ width: 1280, height: 800, minWidth: 760, minHeight: 560, icon: LOGO, autoHideMenuBar: true });
      win.loadURL(`http://127.0.0.1:${PORT}`);
    }
  });
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  if (suggestionPollTimer) clearInterval(suggestionPollTimer);
  if (coreProc) {
    try { coreProc.kill(); } catch {}
  }
});
