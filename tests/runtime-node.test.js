'use strict';

// 打包版「一用工具就疯狂弹 PowerShell 窗口」的回归护栏：
// 核心必须跑在真正的 node.exe 上，而不是 Electron 自带 Node（GUI 子系统，没有控制台）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  nodeExecutableName,
  bundledRuntimePath,
  resolveCoreRuntime,
  needsElectronAsNode
} = require('../core/lib/runtime-node');

const CONTENT = 'C:\\Program Files\\TinyPelican\\resources\\content';
const BUNDLED = path.join(CONTENT, 'runtime', 'node.exe');
const ELECTRON = 'C:\\Program Files\\TinyPelican\\TinyPelican.exe';

const only = (...files) => (file) => files.includes(file);

test('打包版优先用随包内置的 node.exe（控制台子系统）', () => {
  const pick = resolveCoreRuntime({
    contentRoot: CONTENT,
    packaged: true,
    platform: 'win32',
    execPath: ELECTRON,
    npmNode: '',
    exists: only(BUNDLED)
  });
  assert.deepEqual(pick, { runner: BUNDLED, kind: 'bundled' });
});

test('老安装目录里没有 runtime/node.exe 时退回 Electron 当 Node', () => {
  const pick = resolveCoreRuntime({
    contentRoot: CONTENT,
    packaged: true,
    platform: 'win32',
    execPath: ELECTRON,
    exists: () => false
  });
  assert.deepEqual(pick, { runner: ELECTRON, kind: 'electron' });
});

test('非 Windows 保持 Electron 当 Node（没有弹窗问题，也不带 node 二进制）', () => {
  const pick = resolveCoreRuntime({
    contentRoot: '/opt/tinypelican/resources/content',
    packaged: true,
    platform: 'linux',
    execPath: '/opt/tinypelican/TinyPelican',
    exists: () => true
  });
  assert.equal(pick.kind, 'electron');
  assert.equal(pick.runner, '/opt/tinypelican/TinyPelican');
});

test('开发模式沿用 npm 提供的 node（整条链本来就有控制台）', () => {
  const npmNode = 'C:\\Program Files\\nodejs\\node.exe';
  const pick = resolveCoreRuntime({
    contentRoot: CONTENT,
    packaged: false,
    platform: 'win32',
    execPath: ELECTRON,
    npmNode,
    exists: only(npmNode)
  });
  assert.deepEqual(pick, { runner: npmNode, kind: 'npm' });
});

test('开发模式没有 npm node 时就是 electron 自己', () => {
  const pick = resolveCoreRuntime({
    contentRoot: CONTENT,
    packaged: false,
    platform: 'win32',
    execPath: ELECTRON,
    npmNode: 'C:\\missing\\node.exe',
    exists: () => false
  });
  assert.deepEqual(pick, { runner: ELECTRON, kind: 'electron' });
});

test('XIAOTIHU_NODE 覆盖一切（排障用）', () => {
  const pick = resolveCoreRuntime({
    contentRoot: CONTENT,
    packaged: true,
    platform: 'win32',
    execPath: ELECTRON,
    override: 'D:\\tools\\node.exe',
    exists: only(BUNDLED)
  });
  assert.deepEqual(pick, { runner: 'D:\\tools\\node.exe', kind: 'override' });
});

test('只有拿 electron.exe 当 Node 时才带 ELECTRON_RUN_AS_NODE', () => {
  assert.equal(needsElectronAsNode(ELECTRON, ELECTRON), true);
  assert.equal(needsElectronAsNode(BUNDLED, ELECTRON), false);
  assert.equal(needsElectronAsNode('', ELECTRON), false);
});

test('运行时文件名与随包路径', () => {
  assert.equal(nodeExecutableName('win32'), 'node.exe');
  assert.equal(nodeExecutableName('linux'), 'node');
  assert.equal(bundledRuntimePath(CONTENT, 'win32'), BUNDLED);
});

// —— 打包配置护栏：这三处任何一处丢了，弹窗就会在安装版里复活 ——
const ROOT = path.resolve(__dirname, '..');

test('Electron 壳通过 runtime-node 选运行时，并对 node.exe 清掉 ELECTRON_RUN_AS_NODE', () => {
  const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
  assert.match(main, /core\/lib\/runtime-node/);
  assert.match(main, /resolveCoreRuntime\(/);
  assert.match(main, /needsElectronAsNode\(runner/);
});

test('安装包带上 runtime/node.exe（extraResources）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/package.json'), 'utf8'));
  const resources = pkg.build.extraResources || [];
  assert.ok(
    resources.some((entry) => entry.from === '../packaging/runtime' && entry.to === 'content/runtime'),
    'app/package.json 的 build.extraResources 必须包含 ../packaging/runtime → content/runtime'
  );
});

test('构建脚本复制 node.exe 并校验版本', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts/build-installer.ps1'), 'utf8');
  assert.match(script, /packaging\\runtime/);
  assert.match(script, /Copy-Item -Force \$nodeCmd\.Source/);
});
