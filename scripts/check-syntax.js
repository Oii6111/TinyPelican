// 语法自检：对所有手写 JS/MJS 跑一次 node --check。
// 用目录扫描代替 package.json 里逐文件罗列，新增文件自动纳入检查。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  'core',
  'dashboard/src',
  'app',
  'scripts',
  'agent/dsh-event-stream/lib',
  'extract_intents.js',
  'remind.js',
  'check_relations.js',
  '_process_batches.js'
];
const SKIP_DIRS = new Set(['node_modules', 'dsh-home', '.git', 'dist', 'build', 'vendor', 'layout']);
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function collect(target, out = []) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return out;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (EXTENSIONS.has(path.extname(abs).toLowerCase())) out.push(abs);
    return out;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const rel = path.join(target, entry.name);
    if (entry.isDirectory()) collect(rel, out);
    else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(path.join(ROOT, rel));
  }
  return out;
}

const files = [];
for (const target of TARGETS) collect(target, files);
files.sort();

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    failed++;
    const detail = String((e && e.stderr) || (e && e.message) || e).trim();
    console.error(`✗ ${path.relative(ROOT, file)}\n${detail}`);
  }
}

if (failed) {
  console.error(`语法检查失败：${failed}/${files.length} 个文件`);
  process.exit(1);
}
console.log(`语法检查通过：${files.length} 个文件`);
