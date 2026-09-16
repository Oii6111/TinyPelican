// PowerShell 组件自检：
//  1. 含非 ASCII 字符的 .ps1 必须保存为 UTF-8 with BOM —— Windows PowerShell 5.1 无 BOM 时按 ANSI 解码，
//     中文注释会把后面的 param(...) 块解析坏，脚本会以退出码 1 静默失败（曾导致微信回填直接报“脚本退出码 1”）；
//  2. 用真正的 PowerShell 解析器把脚本过一遍，解析不过就失败。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dsh-home']);

// 仓库里所有手写 .ps1（跳过依赖与运行时目录）
function scriptFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) scriptFiles(abs, out);
    else if (entry.name.toLowerCase().endsWith('.ps1')) out.push(abs);
  }
  return out.sort();
}

function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
}

function isAscii(buf) {
  for (const b of buf) {
    if (b > 0x7F) return false;
  }
  return true;
}

// 与运行时保持一致：优先用 Windows PowerShell（powershell.exe），没有就退回 pwsh
function findPowerShell() {
  for (const exe of ['powershell.exe', 'powershell', 'pwsh']) {
    try {
      const r = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { timeout: 20000 });
      if (r.status === 0) return exe;
    } catch {}
  }
  return null;
}

test('PowerShell 脚本：非 ASCII 内容必须带 UTF-8 BOM', () => {
  const files = scriptFiles();
  assert.ok(files.length > 0, '仓库里应有 .ps1 脚本');
  for (const file of files) {
    const name = path.relative(ROOT, file);
    const buf = fs.readFileSync(file);
    assert.ok(
      hasBom(buf) || isAscii(buf),
      `${name} 含非 ASCII 字符却没有 UTF-8 BOM：Windows PowerShell 5.1 会按 ANSI 解码并解析失败`
    );
  }
});

test('PowerShell 脚本：能被 PowerShell 解析器成功解析', (t) => {
  const exe = findPowerShell();
  if (!exe) {
    t.skip('当前环境没有可用的 PowerShell');
    return;
  }
  for (const file of scriptFiles()) {
    const name = path.relative(ROOT, file);
    const cmd = [
      '$errs = $null;',
      `[void][System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(file)}, [ref]$null, [ref]$errs);`,
      'if ($errs -and $errs.Count) { $errs | ForEach-Object { Write-Output ("PARSE_ERROR: " + $_.Message) }; exit 3 }'
    ].join(' ');
    const r = spawnSync(exe, ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `${name} 解析失败：${String(r.stdout || '').trim()} ${String(r.stderr || '').trim()}`);
  }
});
