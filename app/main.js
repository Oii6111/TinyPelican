// 小鹈鹕 TinyPelican — Electron 壳
// 启动时后台拉起核心服务（core/index.js）；核心以退出码 42 退出时自动重启（微信登录/登出热重启）。
// 另有一个无边框回复建议浮窗：复制聊天后自动出现在微信输入框上方，可换一批 / 按描述重写 / 逐条回填。
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell, Tray } = require('electron');
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

const { initializeRuntime, selectWritableDirectory, userDirectories, workspaceId } = require(path.join(PROJECT_ROOT, 'core/lib/startup'));
const { waitForCore } = require(path.join(PROJECT_ROOT, 'core/lib/readiness'));
try {
  const id = workspaceId(PROJECT_ROOT);
  const preferred = isPackaged ? app.getPath('userData') : path.join(app.getPath('appData'), 'TinyPelican-dev', id);
  const candidates = process.env.XIAOTIHU_USER_DATA_DIR ? [process.env.XIAOTIHU_USER_DATA_DIR] : [
    preferred,
    ...userDirectories().map(directory => path.join(directory, isPackaged ? 'TinyPelican' : 'TinyPelican-dev', ...(isPackaged ? [] : [id]), 'electron'))
  ];
  const userData = selectWritableDirectory(candidates, { label: 'XIAOTIHU_USER_DATA_DIR', childDirectory: 'browser-session-v2' });
  app.setPath('userData', userData);
  app.setPath('sessionData', path.join(userData, 'browser-session-v2'));
  initializeRuntime({ root: PROJECT_ROOT, packaged: isPackaged });
} catch (error) {
  if (dialog && typeof dialog.showErrorBox === 'function') {
    dialog.showErrorBox('小鹈鹕 · 启动目录不可用', error.message + '\n可用 XIAOTIHU_DATA_DIR、XIAOTIHU_USER_DATA_DIR 和 DSH_HOME 指定可写目录。');
    if (typeof app.exit === 'function') app.exit(1);
  }
}
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

if (isPackaged) {
  // 随包内置的 DSH（找不到时核心会退回系统安装的 / npx 缓存里的那份）
  const bundledDsh = path.join(PROJECT_ROOT, 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(bundledDsh)) process.env.XIAOTIHU_DSH_BIN = bundledDsh;
}

let coreProc = null;
let coreCrashNotified = false;
let win = null;
let tray = null;
let cardWin = null;
let suggestionPollTimer = null;
let currentAnchor = null;
let lastAutomaticCardPosition = null;
let lastSuggestionId = null;
let lastShowToken = null;
let lastPendingAt = null;
let authCookie = '';
let quitting = false;
let coreStopped = false;

const CARD_WIDTH = 340;
const CARD_HEIGHT = 300;
const CARD_EDGE_GAP = 24;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function createMainWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    icon: LOGO,
    title: '小鹈鹕',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#373830', height: 32 }
    } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });
}

function showMainWindow() {
  if (quitting || !app.isReady()) return;
  if (!win || win.isDestroyed()) createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(LOGO).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('小鹈鹕');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开小鹈鹕', click: showMainWindow },
    { type: 'separator' },
    { label: '停止应用', click: () => app.quit() }
  ]));
  tray.on('double-click', showMainWindow);
}

function readConfig() {
  try {
    const dataDir = process.env.XIAOTIHU_DATA_DIR;
    const configPath = dataDir
      ? path.join(dataDir, 'config.json')
      : path.join(PROJECT_ROOT, 'config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

async function establishDesktopSession() {
  const cfg = readConfig();
  const auth = cfg && cfg.auth;
  if (!auth || !auth.enabled || !auth.username || !auth.password) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: auth.username, password: auth.password })
      });
      if (!res.ok) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      const setCookie = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()[0]
        : res.headers.get('set-cookie');
      const match = String(setCookie || '').match(/xtp_session=([^;]+)/);
      if (!match) return;
      authCookie = `xtp_session=${match[1]}`;
      await session.defaultSession.cookies.set({
        url: `http://127.0.0.1:${PORT}`,
        name: 'xtp_session',
        value: match[1],
        path: '/',
        httpOnly: true
      });
      return;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
}

async function desktopFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authCookie) headers.Cookie = authCookie;
  const res = await fetch(url, { ...options, headers });
  // 会话失效（核心重启 / 过期）：自动重新登录一次再重试，桌面端不该因为重启就掉线
  if (res.status === 401) {
    await establishDesktopSession();
    const retryHeaders = { ...(options.headers || {}) };
    if (authCookie) retryHeaders.Cookie = authCookie;
    return fetch(url, { ...options, headers: retryHeaders });
  }
  return res;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false)); // 端口被占用 = 服务已在线
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

// 运行核心：默认用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1，进程即 node），
// 这样用户机器上不需要另外安装 Node；开发时可用 XIAOTIHU_NODE 指定系统 Node。
function coreRunner() {
  if (process.env.XIAOTIHU_NODE) return process.env.XIAOTIHU_NODE;
  const npmNode = process.env.npm_node_execpath;
  if (!isPackaged && npmNode && fs.existsSync(npmNode)) return npmNode;
  return process.execPath;
}

function coreEnv(runner) {
  const env = { ...process.env };
  if (runner === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
  else delete env.ELECTRON_RUN_AS_NODE;
  if (isPackaged) {
    env.XIAOTIHU_DATA_DIR = process.env.XIAOTIHU_DATA_DIR || '';
    env.DSH_HOME = process.env.DSH_HOME || path.join(env.XIAOTIHU_DATA_DIR, 'dsh-home');
    if (process.env.XIAOTIHU_DSH_BIN) env.XIAOTIHU_DSH_BIN = process.env.XIAOTIHU_DSH_BIN;
  }
  return env;
}

function startCore() {
  if (quitting) return;
  const runner = coreRunner();
  const startedAt = Date.now();
  coreProc = spawn(runner, [CORE], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: coreEnv(runner) });
  coreProc.on('error', () => {});
  coreProc.on('exit', (code) => {
    if (quitting) return;
    if (code === RESTART_EXIT_CODE) {
      startCore(); // 微信登录/登出后的热重启
      return;
    }
    // 刚起来就挂：最典型的原因是另一个小鹈鹕（开发实例/另一个安装版本）占着 18791，
    // 核心会立刻退出，用户只看到「DSH 没起来」。这里直接把原因弹出来。
    if (code !== 0 && Date.now() - startedAt < 15000 && !coreCrashNotified) {
      coreCrashNotified = true;
      dialog.showMessageBox(win, {
        type: 'error',
        title: '小鹈鹕 · 核心没能启动',
        message: '核心服务启动失败（退出码 ' + code + '）',
        detail: '最常见的原因：已经开着一个「小鹈鹕」了（开发实例或另一个安装版本），端口 18791 被占用。\n'
          + '请关掉多余的实例后，再重新打开小鹈鹕。\n\n'
          + '日志：' + path.join(process.env.XIAOTIHU_DATA_DIR || '', 'activity.log'),
        buttons: ['好']
      }).catch(() => {});
    }
  });
  return coreProc;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function positionAtScreenCorner() {
  if (!cardWin || cardWin.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const [width, height] = cardWin.getSize();
  const position = [area.x + area.width - width - 16, area.y + area.height - height - 16];
  cardWin.setPosition(...position);
  lastAutomaticCardPosition = position;
}

function cardWasManuallyMoved() {
  if (!cardWin || cardWin.isDestroyed() || !lastAutomaticCardPosition) return false;
  return cardWin.getPosition().some((value, index) => Math.abs(value - lastAutomaticCardPosition[index]) > 2);
}

function positionFloatingWindows(anchor = currentAnchor) {
  if (!cardWin || cardWin.isDestroyed()) return;
  if (cardWasManuallyMoved()) return;

  if (!anchor || !Number.isFinite(Number(anchor.x)) || !Number.isFinite(Number(anchor.y))) {
    positionAtScreenCorner();
    return;
  }

  const anchorX = Number(anchor.x);
  const anchorY = Number(anchor.y);
  const [cardWidth, cardHeight] = cardWin.getSize();

  // 用锚点找最近的显示器，并限制在该显示器工作区内，防止微信位于副屏/屏幕边缘时窗口越界。
  const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY });
  const area = display.workArea;

  // 卡片贴在微信输入框右上方：右下角对齐锚点再左移一点，向上抬出输入框区域。
  const cardX = clamp(Math.round(anchorX - cardWidth + CARD_EDGE_GAP), area.x, area.x + area.width - cardWidth);
  const cardY = clamp(Math.round(anchorY - cardHeight - 12), area.y, area.y + area.height - cardHeight);
  cardWin.setPosition(cardX, cardY);
  lastAutomaticCardPosition = [cardX, cardY];
}

async function refreshCurrentAnchor() {
  try {
    const res = await desktopFetch(`http://127.0.0.1:${PORT}/api/reply-suggestions/current/refresh-position`, { method: 'POST' });
    if (!res.ok) return 'error';
    const data = await res.json();
    const s = data && data.suggestion;
    if (!s) return 'none';
    const anchor = s.anchor && Number.isFinite(Number(s.anchor.x)) && Number.isFinite(Number(s.anchor.y))
      ? { x: Number(s.anchor.x), y: Number(s.anchor.y) }
      : null;
    lastSuggestionId = s.id;
    lastShowToken = Number(s.showToken) || 1;
    currentAnchor = anchor;
    positionFloatingWindows(currentAnchor);
    return 'ok';
  } catch {
    return 'error';
  }
}

function hideCard() {
  if (cardWin && !cardWin.isDestroyed() && cardWin.isVisible()) cardWin.hide();
  lastAutomaticCardPosition = null;
}

// 卡片内容高度变化时把窗口收到刚好包住卡片，避免透明区域挡住微信。
function resizeCard(size) {
  if (!cardWin || cardWin.isDestroyed()) return;
  const width = clamp(Math.round(Number(size && size.width) || CARD_WIDTH), 280, 460);
  const height = clamp(Math.round(Number(size && size.height) || CARD_HEIGHT), 120, 620);
  const [curWidth, curHeight] = cardWin.getSize();
  if (curWidth === width && curHeight === height) return;
  const previousPosition = cardWin.getPosition();
  const manuallyMoved = cardWasManuallyMoved();
  const wasResizable = cardWin.isResizable();
  try {
    if (!wasResizable) cardWin.setResizable(true);
    cardWin.setSize(width, height);
    if (!wasResizable) cardWin.setResizable(false);
  } catch {
    try { cardWin.setSize(width, height); } catch {}
  }
  if (manuallyMoved) {
    const area = screen.getDisplayNearestPoint({ x: previousPosition[0], y: previousPosition[1] }).workArea;
    cardWin.setPosition(
      clamp(previousPosition[0], area.x, area.x + area.width - width),
      clamp(previousPosition[1], area.y, area.y + area.height - height)
    );
  } else {
    positionFloatingWindows(currentAnchor);
  }
}

function createFloatingWindows() {
  const preload = path.join(__dirname, 'preload.js');

  cardWin = new BrowserWindow({
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
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
  cardWin.webContents.setWindowOpenHandler(({ url }) => {
    try { if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {}
    return { action: 'deny' };
  });
  cardWin.setBackgroundColor('#00000000');
  if (typeof cardWin.setHasShadow === 'function') cardWin.setHasShadow(false);
  cardWin.setAlwaysOnTop(true, 'screen-saver');

  positionFloatingWindows();
}

async function pollSuggestions() {
  if (quitting) return;
  try {
    const res = await desktopFetch(`http://127.0.0.1:${PORT}/api/reply-suggestions/current`);
    if (res.status === 401) {
      await establishDesktopSession();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (quitting) return;
    const s = data && data.suggestion;
    const pending = data && data.pending;
    if (!s && !pending) {
      lastSuggestionId = null;
      lastShowToken = null;
      lastPendingAt = null;
      currentAnchor = null;
      hideCard();
      return;
    }

    // 模型还没返回：先按 pending 里的锚点把浮窗拉起来，卡片自己会显示「思考中」
    if (pending && pending.startedAt && pending.startedAt !== lastPendingAt) {
      lastPendingAt = pending.startedAt;
      const pendingAnchor = pending.anchor && Number.isFinite(Number(pending.anchor.x)) && Number.isFinite(Number(pending.anchor.y))
        ? { x: Number(pending.anchor.x), y: Number(pending.anchor.y) }
        : currentAnchor;
      currentAnchor = pendingAnchor;
      positionFloatingWindows(currentAnchor);
      cardWin.showInactive();
      if (!cardWin.isVisible()) cardWin.show();
      cardWin.webContents.send('suggestion:shown');
      return;
    }
    if (!pending) lastPendingAt = null;
    if (!s) return;

    // 只在「新一批建议」或「同一批被要求重新显示」（showToken 变化，比如用户又复制了一次同一段聊天）
    // 时重新定位并显示，避免每 800ms 重复 setPosition()。用户点 ✕ 收起只是隐藏窗口，服务端建议仍在，
    // 所以要靠 showToken 才能区分「收起」和「重新要一次」。
    const showToken = Number(s.showToken) || 1;
    if (s.id === lastSuggestionId && showToken === lastShowToken) return;
    lastSuggestionId = s.id;
    lastShowToken = showToken;
    // 重新读一次窗口矩形：微信窗口在复制之后移动过也能贴住输入框。
    await refreshCurrentAnchor();
    if (!cardWin || cardWin.isDestroyed()) return;
    positionFloatingWindows(currentAnchor);
    cardWin.showInactive();
    if (!cardWin.isVisible()) cardWin.show();
    cardWin.webContents.send('suggestion:shown');
  } catch {}
}

app.whenReady().then(async () => {
  if (!ownsInstance || quitting) return;
  if (await portFree(PORT)) {
    startCore();
  }
  try {
    if (process.versions && process.versions.node) await waitForCore({
      base: `http://127.0.0.1:${PORT}`, root: PROJECT_ROOT, dataDir: process.env.XIAOTIHU_DATA_DIR,
      isRunning: () => !quitting && (!coreProc || (coreProc.exitCode === null && coreProc.signalCode === null)),
      fetchImpl: fetch
    });
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error', title: '小鹈鹕 · 核心服务未就绪', message: error.message,
      detail: '启动日志：' + path.join(process.env.XIAOTIHU_DATA_DIR, 'core-startup.log'),
      buttons: ['关闭']
    });
    app.quit();
    return;
  }
  await establishDesktopSession();
  if (quitting) return;

  createTray();
  createMainWindow();

  createFloatingWindows();

  // 首次运行引导：没配模型 Key 时直接告诉用户去哪儿填
  {
    try {
      const cfg = readConfig();
      const providerName = (cfg.engine && cfg.engine.provider) || '';
      const prov = (cfg.engine && cfg.engine.providers && cfg.engine.providers[providerName]) || {};
      if (!prov.apiKey && providerName !== 'ollama') {
        win.webContents.once('did-finish-load', () => {
          dialog.showMessageBox(win, {
            type: 'info',
            title: '小鹈鹕 · 首次使用',
            message: '还差一步：填入模型 API Key',
            detail: '打开「设置 → 模型服务」，选择服务商并填入 API Key 与模型名后保存。\n保存后核心会自动重启，回复建议、意图识别与 DSH Agent 都会使用这个模型。',
            buttons: ['好']
          }).catch(() => {});
        });
      }
    } catch {}
  }

  ipcMain.on('suggestion:hide-card', () => hideCard());
  ipcMain.on('suggestion:resize', (event, size) => {
    if (event && event.sender && event.sender === (cardWin && cardWin.webContents)) resizeCard(size);
  });

  // 250ms：本地回环上的小接口，代价可忽略，但卡片能更快弹出来（原 800ms 光等待就要 0.8s）
  suggestionPollTimer = setInterval(pollSuggestions, 250);
  pollSuggestions();

  app.on('activate', showMainWindow);
});

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('before-quit', (event) => {
  quitting = true;
  if (suggestionPollTimer) clearInterval(suggestionPollTimer);
  if (cardWin && !cardWin.isDestroyed()) cardWin.destroy();
  if (coreStopped || !coreProc || coreProc.exitCode !== null || coreProc.signalCode !== null) return;
  event.preventDefault();
  if (coreProc.shutdownRequested) return;
  coreProc.shutdownRequested = true;
  const child = coreProc;
  const timeout = setTimeout(() => {
    try { child.kill(); } catch {}
  }, 5000);
  child.once('exit', () => {
    clearTimeout(timeout);
    coreStopped = true;
    app.quit();
  });
  if (child.connected) {
    child.send({ type: 'shutdown' }, (error) => {
      if (error) { try { child.kill(); } catch {} }
    });
  } else {
    try { child.kill(); } catch {}
  }
});

app.on('will-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (suggestionPollTimer) clearInterval(suggestionPollTimer);
  if (coreProc) {
    try { coreProc.kill(); } catch {}
  }
});
