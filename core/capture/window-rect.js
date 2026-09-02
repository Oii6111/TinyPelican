// 按窗口句柄读取最新矩形与 DPI，用于建议卡片显示前刷新定位。
// 成功：{ pid, bounds: { left, top, right, bottom }, dpi }；失败：null。
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'get-window-rect.ps1');

function parseLine(line) {
  const m = line.match(/^OK\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)$/);
  if (!m) return null;
  const left = Number(m[2]);
  const top = Number(m[3]);
  const right = Number(m[4]);
  const bottom = Number(m[5]);
  if (!Number.isFinite(left) || !Number.isFinite(top) ||
      !Number.isFinite(right) || !Number.isFinite(bottom) ||
      right <= left || bottom <= top) return null;
  return {
    pid: m[1] === '0' ? null : m[1],
    bounds: { left, top, right, bottom },
    dpi: Number(m[6]) || 0
  };
}

function getWindowRect(handle) {
  return new Promise((resolve) => {
    const h = Number(handle);
    if (!Number.isFinite(h) || h <= 0) return resolve(null);

    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-Handle', String(h)
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const parsed = parseLine(out.trim());
      resolve(parsed);
    });
  });
}

module.exports = { getWindowRect, parseLine };
