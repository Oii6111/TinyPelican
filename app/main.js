// 小鹈鹕 TinyPelican — Electron 壳
// 启动时后台拉起核心服务（core/index.js）；核心以退出码 42 退出时自动重启（微信登录/登出热重启）。
// 另有一个无边框回复建议浮窗：复制聊天后自动出现在微信输入框上方，可换一批 / 按描述重写 / 逐条回填。
const { app, BrowserWindow, dialog, ipcMain, screen, session } = require('electron');
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
  // DSH 自己的 home 放在用户数据目录：首次运行由 DSH 自己生成 web profile（实测 4 秒完成，不需要联网）
  const dshHome = path.join(dataDir, 'dsh-home');
  fs.mkdirSync(dshHome, { recursive: true });
  process.env.DSH_HOME = dshHome;
  // 随包内置的 DSH（找不到时核心会退回系统安装的 / npx 缓存里的那份）
  const bundledDsh = path.join(PROJECT_ROOT, 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (fs.existsSync(bundledDsh)) process.env.XIAOTIHU_DSH_BIN = bundledDsh;
  // 首次运行：只拷配置模板（绝不打包开发者自己的 config.json，里面可能有 API Key）
  const cfgSrc = path.join(PROJECT_ROOT, 'config.example.json');
  const cfgDst = path.join(dataDir, 'config.json');
  if (fs.existsSync(cfgSrc) && !fs.existsSync(cfgDst)) {
    fs.copyFileSync(cfgSrc, cfgDst);
  }
}

let coreProc = null;
let win = null;
let cardWin = null;
let suggestionPollTimer = null;
let currentAnchor = null;
let lastSuggestionId = null;
let lastShowToken = null;
let lastPendingAt = null;
let authCookie = '';

const CARD_WIDTH = 340;
const CARD_HEIGHT = 300;
const CARD_EDGE_GAP = 24;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function readConfig() {
  try {
    const dataDir = process.env.XIAOTIHU_DATA_DIR;
    const configPath = isPackaged && dataDir
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
function coreEnv() {
  const env = { ...process.env };
  if (!process.env.XIAOTIHU_NODE) env.ELECTRON_RUN_AS_NODE = '1';
  if (isPackaged) {
    env.XIAOTIHU_DATA_DIR = process.env.XIAOTIHU_DATA_DIR || '';
    env.DSH_HOME = process.env.DSH_HOME || path.join(env.XIAOTIHU_DATA_DIR, 'dsh-home');
    if (process.env.XIAOTIHU_DSH_BIN) env.XIAOTIHU_DSH_BIN = process.env.XIAOTIHU_DSH_BIN;
  }
  return env;
}

function startCore() {
  const runner = process.env.XIAOTIHU_NODE || process.execPath;
  coreProc = spawn(runner, [CORE], { stdio: 'ignore', windowsHide: true, env: coreEnv() });
  coreProc.on('error', () => {});
  coreProc.on('exit', (code) => {
    if (code === RESTART_EXIT_CODE) {
      startCore(); // 微信登录/登出后的热重启
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
  cardWin.setPosition(area.x + area.width - width - 16, area.y + area.height - height - 16);
}

function positionFloatingWindows(anchor = currentAnchor) {
  if (!cardWin || cardWin.isDestroyed()) return;

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
}

// 卡片内容高度变化时把窗口收到刚好包住卡片，避免透明区域挡住微信。
function resizeCard(size) {
  if (!cardWin || cardWin.isDestroyed()) return;
  const width = clamp(Math.round(Number(size && size.width) || CARD_WIDTH), 280, 460);
  const height = clamp(Math.round(Number(size && size.height) || CARD_HEIGHT), 120, 620);
  const [curWidth, curHeight] = cardWin.getSize();
  if (curWidth === width && curHeight === height) return;
  const wasResizable = cardWin.isResizable();
  try {
    if (!wasResizable) cardWin.setResizable(true);
    cardWin.setSize(width, height);
    if (!wasResizable) cardWin.setResizable(false);
  } catch {
    try { cardWin.setSize(width, height); } catch {}
  }
  positionFloatingWindows(currentAnchor);
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
  cardWin.setBackgroundColor('#00000000');
  if (typeof cardWin.setHasShadow === 'function') cardWin.setHasShadow(false);
  cardWin.setAlwaysOnTop(true, 'screen-saver');

  positionFloatingWindows();
}

async function pollSuggestions() {
  try {
    const res = await desktopFetch(`http://127.0.0.1:${PORT}/api/reply-suggestions/current`);
    if (res.status === 401) {
      await establishDesktopSession();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
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
  if (await portFree(PORT)) {
    startCore();
    await sleep(3000);
  }
  await establishDesktopSession();

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

  // 首次运行引导：没配模型 Key 时直接告诉用户去哪儿填
  if (isPackaged) {
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
