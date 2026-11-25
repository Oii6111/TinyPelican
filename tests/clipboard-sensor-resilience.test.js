'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-capture-resilience-'));
process.env.XIAOTIHU_DATA_DIR = temporary;

const originalSpawn = childProcess.spawn;
let attempts = 0;
childProcess.spawn = () => {
  attempts += 1;
  if (attempts === 1) {
    // 真实机器上的形态：安全软件 / 组策略直接拒绝创建 powershell.exe
    const error = new Error('spawn powershell.exe EPERM');
    error.code = 'EPERM';
    throw error;
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kill = () => { child.emit('exit', null); return true; };
  return child;
};
const { ClipboardWatcher } = require('../core/capture/clipboard');
childProcess.spawn = originalSpawn;

test('剪贴板传感器起不来时不抛出、不拖垮核心，并会自行重试', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const watcher = new ClipboardWatcher({ config: { capture: { enabled: true } } });
  context.after(() => watcher.stop());

  assert.doesNotThrow(() => watcher.start());
  assert.equal(watcher.child, null, '第一次 spawn 抛错后不应留下半启动的子进程');
  assert.equal(watcher.running, false);

  context.mock.timers.tick(15000);
  assert.equal(attempts, 2, '15 秒后应自动重试一次');
  assert.ok(watcher.child, '重试成功后应重新持有子进程');
});
