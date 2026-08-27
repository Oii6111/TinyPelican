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
    process.exit(code || 0);
  });
  child.on('error', (e) => {
    console.error('[launcher] 启动核心失败', e);
    process.exit(1);
  });
}

start();
