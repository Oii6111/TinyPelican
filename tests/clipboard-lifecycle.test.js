'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-capture-lifecycle-'));
process.env.XIAOTIHU_DATA_DIR = temporary;
const children = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kill = () => { child.emit('exit', null); return true; };
  child.options = options;
  children.push(child);
  return child;
};
const { ClipboardWatcher, parseSensorLine } = require('../core/capture/clipboard');
childProcess.spawn = originalSpawn;

test('sensor exits restart capture and stopping cancels pending restart', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const watcher = new ClipboardWatcher({ config: { capture: { enabled: true } } });
  context.after(() => watcher.stop());
  watcher.start();
  const first = watcher.child;
  assert.equal(first.options.env.TEMP, path.join(temporary, 'tmp', 'clipboard-sensor'));
  assert.equal(first.options.env.TMP, first.options.env.TEMP);
  first.emit('exit', 1);
  assert.equal(watcher.child, null);
  context.mock.timers.tick(5000);
  assert.ok(watcher.child);
  assert.notEqual(watcher.child, first);
  watcher.child.emit('exit', 1);
  watcher.stop();
  context.mock.timers.tick(5000);
  assert.equal(watcher.child, null);
});

test('missing native window component still emits a valid complete chat frame', { skip: process.platform !== 'win32' }, async () => {
  const chat = ['Friend', '2026年11月6日 20:53', 'test message'].join('\n');
  const encoded = Buffer.from(chat).toString('base64');
  const script = path.resolve(__dirname, '../core/capture/clipboard-sensor.ps1').replace(/'/g, "''");
  const command = `function Add-Type { [CmdletBinding()] param([string]$AssemblyName, [Parameter(Position=0)][string]$TypeDefinition) if ($TypeDefinition) { throw 'native unavailable' } }; function Get-Clipboard { param([switch]$Raw) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) }; & '${script}'`;
  await new Promise((resolve, reject) => {
    const child = originalSpawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('sensor did not emit a chat frame: ' + errors)); }, 12000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const frame = output.split(/\r?\n/).find(line => line.startsWith('CHANGE '));
      if (!frame || !output.endsWith('\n')) return;
      clearTimeout(timeout);
      child.kill();
      try {
        const parsed = parseSensorLine(frame);
        assert.ok(parsed, 'native metadata failure must not shift protocol fields');
        assert.equal(Buffer.from(parsed.encoded, 'base64').toString('utf8'), chat);
        assert.equal(parsed.handle, null);
        assert.equal(parsed.pid, null);
        resolve();
      } catch (error) { reject(error); }
    });
  });
});

test('malformed metadata cannot be decoded as a legacy text frame', () => {
  assert.equal(parseSensorLine('CHANGE  0 - 0 0 0 0 0 aGVsbG8='), null);
});

test('a live but stalled sensor is replaced, heartbeats keep a healthy one alive', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const watcher = new ClipboardWatcher({ config: { capture: { enabled: true } } });
  context.after(() => watcher.stop());
  watcher.start();
  const first = watcher.child;
  for (let index = 0; index < 8; index++) {
    context.mock.timers.tick(3000);
    first.stdout.emit('data', 'HEARTBEAT\n');
  }
  assert.equal(watcher.child, first);
  context.mock.timers.tick(18000);
  assert.equal(watcher.child, null);
  context.mock.timers.tick(5000);
  assert.ok(watcher.child);
  assert.notEqual(watcher.child, first);
});

// 交付失败不能让内容被永久当成「已导入」：
// 曾经是在解析时就把消息写进 seen，结果数据库被占用导致交付失败后，同一段聊天
// 无论再复制多少次都只报「重复消息」，永远不重试落库（真实踩到过：联系人 0 条消息）。
test('交付失败的消息不算已导入，重新复制还能入库', () => {
  const text = [
    '张三', '2026年11月20日 10:00', '你好',
    '', '我', '2026年11月20日 10:01', '在的', ''
  ].join('\n');
  const windowRef = { handle: '1', processName: 'Weixin', bounds: { left: 0, top: 0, right: 800, bottom: 600 }, dpi: 96 };

  let attempts = 0;
  const delivered = [];
  const watcher = new ClipboardWatcher({
    onBatch: (batch) => {
      attempts += 1;
      if (attempts === 1) throw new Error('unable to open database file');
      delivered.push(batch);
    },
    config: { pollMs: 1, selfNicknames: ['我'], capture: { enabled: true, readSessionTitle: false } },
    sessionReader: false,
    stripCapture: async () => null
  });

  // 第一次：交付抛错
  watcher._handleClip(text, windowRef);
  watcher._flushSync();
  assert.equal(attempts, 1);
  assert.equal(delivered.length, 0);

  // 第二次复制同一段：必须仍然被当作新消息（不能判成 repeat），并且这次成功交付
  watcher._handleClip(text, windowRef);
  watcher._flushSync();
  assert.equal(attempts, 2);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].repeat, false, '交付失败过的批次不能标记成「重复复制」');
  assert.equal(delivered[0].msgs.length, 2);
});

// 交付成功后才去重：同一段再复制一次就是 repeat，且不会重复入库
test('交付成功后同一段再复制判为重复', () => {
  const text = ['张三', '2026年11月20日 10:00', '你好', '', '我', '2026年11月20日 10:01', '在的', ''].join('\n');
  const windowRef = { handle: '1', processName: 'Weixin', bounds: { left: 0, top: 0, right: 800, bottom: 600 }, dpi: 96 };
  const batches = [];
  const watcher = new ClipboardWatcher({
    onBatch: (batch) => batches.push(batch),
    config: { pollMs: 1, selfNicknames: ['我'], capture: { enabled: true, readSessionTitle: false } },
    sessionReader: false,
    stripCapture: async () => null
  });

  watcher._handleClip(text, windowRef);
  watcher._flushSync();
  watcher._handleClip(text, windowRef);
  watcher._flushSync();

  assert.equal(batches.length, 2);
  assert.equal(batches[0].msgs.length, 2);
  assert.equal(batches[1].repeat, true);
  assert.equal(batches[1].msgs.length, 0);
});
