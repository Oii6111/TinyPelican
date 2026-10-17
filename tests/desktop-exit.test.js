'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('关闭主窗口进入托盘，恢复窗口后通过托盘停止核心且不再次重启', async () => {
  const windows = [];
  let ready;
  let spawns = 0;
  let exited = false;
  let tray;
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, connected: true });
  child.send = (message) => { assert.equal(message.type, 'shutdown'); };
  child.kill = () => { assert.notEqual(child.exitCode, null); };
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    disableHardwareAcceleration() {},
    getPath: () => '/tmp',
    setPath() {},
    requestSingleInstanceLock: () => true,
    isReady: () => true,
    whenReady: () => ({ then: (callback) => { ready = callback; } }),
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault: () => { prevented = true; } });
      if (!prevented) { app.emit('will-quit'); exited = true; }
    }
  });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.destroyed = false; this.webContents = { setWindowOpenHandler() {} }; windows.push(this); }
    loadURL() {}
    setBackgroundColor() {}
    setAlwaysOnTop() {}
    getSize() { return [340, 300]; }
    setPosition() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return Boolean(this.minimized); }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) this.destroy();
    }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class Tray extends EventEmitter {
    constructor() { super(); tray = this; }
    setToolTip(value) { this.toolTip = value; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const sandbox = {
    require(name) {
      if (name === 'electron') return { app, BrowserWindow: Window, Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, ipcMain: new EventEmitter(), screen: { getPrimaryDisplay: () => ({ workArea: { width: 1000, height: 800 } }) } };
      if (name === 'child_process') return { spawn: () => { spawns++; return child; } };
      if (name === 'fs') return { mkdirSync() {}, readFileSync: () => '{}' };
      if (name === 'net') return { createServer() { const server = new EventEmitter(); server.close = () => {}; server.listen = () => server.emit('listening'); return server; } };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '../app'),
    process: { execPath: 'electron', platform: 'win32', env: {} },
    setTimeout: (callback, delay) => delay === 3000 ? setImmediate(callback) : setTimeout(callback, delay),
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    fetch: async () => { throw new Error('offline'); }
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../app/main.js'), 'utf8'), sandbox);
  await ready();
  assert.equal(windows.length, 2);
  assert.equal(windows[0].options.titleBarStyle, 'hidden');
  assert.equal(windows[0].options.titleBarOverlay.color, '#ffffff');
  assert.equal(windows[0].options.titleBarOverlay.height, 32);
  assert.equal(windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(windows[0].options.webPreferences.nodeIntegration, false);
  windows[0].close();
  assert.equal(windows[0].destroyed, false);
  assert.equal(windows[0].visible, false);
  assert.equal(windows[1].destroyed, false);
  assert.equal(child.shutdownRequested, undefined);
  assert.equal(exited, false);
  assert.equal(tray.toolTip, '小鹈鹕');
  tray.emit('double-click');
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].focused, true);
  windows[0].minimized = true;
  windows[0].close();
  tray.menu.find((item) => item.label === '打开小鹈鹕').click();
  assert.equal(windows[0].minimized, false);
  assert.equal(windows[0].visible, true);
  windows[0].close();
  app.emit('second-instance');
  assert.equal(windows[0].visible, true);
  tray.menu.find((item) => item.label === '停止应用').click();
  assert.equal(windows[1].destroyed, true);
  assert.equal(child.shutdownRequested, true);
  assert.equal(exited, false);
  child.exitCode = 42;
  child.emit('exit', 42);
  assert.equal(exited, true);
  assert.equal(tray.destroyed, true);
  windows[0].close();
  assert.equal(windows[0].destroyed, true);
  assert.equal(spawns, 1);
});
