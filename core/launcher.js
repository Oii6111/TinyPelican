// 小鹈鹕核心 — 守护启动器
// 拉起核心进程；核心以退出码 42 退出时自动重启（用于微信登录/登出后的热重启）。
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'index.js');
const RESTART_EXIT_CODE = 42;

function start() {
  const child = spawn(process.execPath, [CHILD], { stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => {
    if (code === RESTART_EXIT_CODE) {
      console.log('[launcher] 收到重启信号，拉起新核心...');
      start();
      return;
    }
    console.log('[launcher] 核心退出，code=' + code);
    // 核心的失败原因写进了 activity.log，控制台里只剩这一句会让人以为「DSH 自己起不来」。
    // 端口冲突是最常见的启动失败，这里直接给出可执行的下一步。
    if (code) {
      console.log('[launcher] 启动失败。最常见的原因是已经开着一个小鹈鹕（端口被占用）；');
      console.log('[launcher] 请先关闭已有的小鹈鹕窗口/进程，再重新 npm start。详细原因见 activity.log。');
    }
    process.exit(code || 0);
  });
  child.on('error', (e) => {
    console.error('[launcher] 启动核心失败', e);
    process.exit(1);
  });
}

start();
