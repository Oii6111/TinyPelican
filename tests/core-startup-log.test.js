'use strict';

// 回归：核心在用户机器上起不来时，必须留下可读的 core-startup.log，
// 并且弹窗里直接给出最后几行 —— 之前的弹窗让人看一个从来没有被写过的文件。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('核心退出时把输出写入 core-startup.log，并把最后几行放进弹窗', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-core-log-'));
  // 开发态没有 editions 分层：数据目录就是 XIAOTIHU_DATA_DIR 本身。
  const dataDir = temporary;
  const previousDataDir = process.env.XIAOTIHU_DATA_DIR;
  process.env.XIAOTIHU_DATA_DIR = temporary;

  const dialogs = [];
  let ready;
  let child;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    disableHardwareAcceleration() {},
    getPath: () => temporary,
    setPath() {},
    requestSingleInstanceLock: () => true,
    isReady: () => true,
    whenReady: () => ({ then: (callback) => { ready = callback; } }),
    quit() {},
    exit() {}
  });
  const dialog = {
    showMessageBox: async (options) => { dialogs.push(options); return { response: 0 }; },
    showErrorBox() {}
  };
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = { setWindowOpenHandler() {} }; }
    loadURL() {}
    setBackgroundColor() {}
    setAlwaysOnTop() {}
    getSize() { return [340, 300]; }
    setPosition() {}
    isDestroyed() { return false; }
    isVisible() { return false; }
    isMinimized() { return false; }
    show() {}
    hide() {}
    focus() {}
  }
  const sandbox = {
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window, Tray: class extends EventEmitter {}, Menu: { buildFromTemplate: (items) => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, ipcMain: new EventEmitter(), screen: { getPrimaryDisplay: () => ({ workArea: { width: 1000, height: 800 } }), getDisplayNearestPoint: () => ({ workArea: { width: 1000, height: 800 } }), getCursorScreenPoint: () => ({ x: 0, y: 0 }) }, dialog, session: { defaultSession: { cookies: { set: async () => {} } } }, shell: { openExternal() {} } };
      if (name === 'child_process') {
        return {
          spawn: () => {
            child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.exitCode = null;
            child.signalCode = null;
            child.connected = true;
            child.send = () => {};
            child.kill = () => {};
            return child;
          }
        };
      }
      if (name === 'net') return { createServer() { const server = new EventEmitter(); server.close = () => {}; server.listen = () => server.emit('listening'); return server; } };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '../app'),
    process: { execPath: 'electron', platform: 'win32', env: { XIAOTIHU_DATA_DIR: temporary }, versions: { node: '24.13.0' } },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    fetch: async () => { throw new Error('offline'); }
  };
  try {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../app/main.js'), 'utf8'), sandbox);
    const pending = ready();
    await Promise.resolve();
    assert.ok(child, '核心应已被拉起');
    child.stderr.emit('data', 'Error: spawn powershell.exe EPERM\n    at ClipboardWatcher.start\n');
    child.stdout.emit('data', '[core] 启动失败\n');
    child.exitCode = 1;
    child.emit('exit', 1);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logFile = path.join(dataDir, 'core-startup.log');
    assert.ok(fs.existsSync(logFile), '应生成 core-startup.log');
    const content = fs.readFileSync(logFile, 'utf8');
    assert.match(content, /spawn powershell\.exe EPERM/);
    assert.match(content, /启动失败/);

    const readiness = dialogs.find((options) => String(options.title || '').includes('核心服务未就绪'));
    assert.ok(readiness, '核心退出后应弹出「核心服务未就绪」');
    assert.match(readiness.message, /退出码 1/);
    assert.match(readiness.detail, /core-startup\.log/);
    assert.match(readiness.detail, /spawn powershell\.exe EPERM/);
  } finally {
    if (previousDataDir === undefined) delete process.env.XIAOTIHU_DATA_DIR;
    else process.env.XIAOTIHU_DATA_DIR = previousDataDir;
  }
});
