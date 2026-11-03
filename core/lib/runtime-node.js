// 小鹈鹕 — 打包版核心用哪个运行时（node.exe 还是 Electron 自带的 Node）
//
// 为什么打包版不能只靠 `windowsHide` 把 Windows 弹窗压下去：
// Electron 内核（electron.exe）是 **GUI 子系统**程序，用 `ELECTRON_RUN_AS_NODE=1` 当 Node 跑时
// 进程**根本没有控制台**，`windowsHide` 也就没有控制台可以藏。而 Windows 里凡是控制台子系统的
// 子进程（powershell.exe / pwsh.exe / 各种 CLI）在「父进程没有控制台」时被拉起，系统会给它
// **新建一个可见的控制台窗口**。DSH 执行工具命令走的是自带的 windows-job runner（原生
// CreateProcessW，creationFlags 只有 CREATE_UNICODE_ENVIRONMENT|CREATE_SUSPENDED，不带
// CREATE_NO_WINDOW），这段代码在 node_modules 里、产品改不到，于是「一用工具就疯狂弹 PS 窗口」。
//
// 开发版为什么没有这个毛病：`npm start` / `start.ps1` 的整条链都是终端里的 node.exe
// （控制台子系统），控制台一路继承下去，子进程永远不会新建窗口。当时在 core 里补的
// `windowsHide: true` 只盖住了「我们自己 spawn 的进程」；打包版换成真正的 node.exe 之后，
// 隐藏的控制台会一路继承给 DSH、它的 runner 和 pwsh，DSH 内部那些没带 windowsHide 的 spawn
// 也不会再冒窗口。
'use strict';

const fs = require('fs');
const path = require('path');

// 独立运行时文件名：Windows 才有 node.exe 这个单文件二进制
function nodeExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

// 随包内置的运行时：electron-builder 把 packaging/runtime 复制到 resources/content/runtime
function bundledRuntimePath(contentRoot, platform = process.platform) {
  return path.join(contentRoot, 'runtime', nodeExecutableName(platform));
}

function defaultExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// 选核心进程的可执行文件。
//   override  XIAOTIHU_NODE（排障/开发用，显式指定就用它）
//   npm       `electron .` 里由 npm 提供的 node（开发模式）
//   bundled   随包内置的 node.exe（打包版首选；这份是控制台子系统，弹窗的根源解在这里）
//   electron  兜底：Electron 自带 Node（没有 runtime/node.exe 的老安装目录 / 非 Windows）
// 返回 { runner, kind }：kind 用来打日志与测试断言。
function resolveCoreRuntime({
  contentRoot,
  packaged = false,
  platform = process.platform,
  execPath = process.execPath,
  override = '',
  npmNode = '',
  exists = defaultExists
} = {}) {
  const forced = String(override || '').trim();
  if (forced) return { runner: forced, kind: 'override' };

  if (!packaged) {
    const system = String(npmNode || '').trim();
    if (system && exists(system)) return { runner: system, kind: 'npm' };
    return { runner: execPath, kind: 'electron' };
  }

  // 只有 Windows 有「没有控制台就弹窗」的问题；其他平台保持原来的 Electron 当 Node
  if (platform === 'win32') {
    const bundled = bundledRuntimePath(contentRoot, platform);
    if (exists(bundled)) return { runner: bundled, kind: 'bundled' };
  }
  return { runner: execPath, kind: 'electron' };
}

// spawn 时是否要带 ELECTRON_RUN_AS_NODE：只有拿 electron.exe 当 Node 用时才需要
function needsElectronAsNode(runner, execPath = process.execPath) {
  return Boolean(runner) && runner === execPath;
}

module.exports = {
  nodeExecutableName,
  bundledRuntimePath,
  resolveCoreRuntime,
  needsElectronAsNode
};
