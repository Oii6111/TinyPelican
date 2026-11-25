// 静态检查 dashboard 的 ESM 依赖图：每个 `import { X } from './y.mjs'` 的 X 必须在 y 里真的导出。
// 浏览器里这类错误属于链接期失败，会导致整个入口模块不执行（表现就是白屏），但 Node 语法检查看不出来。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'dashboard', 'src');
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs);
    else if (entry.name.endsWith('.mjs')) files.push(abs);
  }
})(ROOT);

const exportCache = new Map();
function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const names = new Set();
  let source = '';
  try { source = fs.readFileSync(file, 'utf8'); } catch { exportCache.set(file, names); return names; }

  const patterns = [
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*export\s+\{([^}]*)\}/gm
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) {
      if (re.source.includes('\\{')) {
        for (const part of m[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop().trim();
          if (name) names.add(name);
        }
      } else {
        names.add(m[1]);
      }
    }
  }
  // export * from './x.mjs' → 视为未知，跳过检查（本项目没用到）
  if (/^\s*export\s+\*/m.test(source)) names.add('*');
  exportCache.set(file, names);
  return names;
}

const problems = [];
const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = importRe.exec(source))) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), spec);
    if (!target.endsWith('.mjs')) continue;
    if (!fs.existsSync(target)) {
      problems.push(`${path.relative(ROOT, file)} → ${spec}（文件不存在）`);
      continue;
    }
    const available = exportsOf(target);
    if (available.has('*')) continue;
    for (const part of m[1].split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const imported = raw.split(/\s+as\s+/)[0].trim();
      if (!imported) continue;
      if (!available.has(imported)) {
        problems.push(`${path.relative(ROOT, file)} → ${spec}：没有导出 "${imported}"`);
      }
    }
  }
}

if (problems.length) {
  console.error(`发现 ${problems.length} 处 ESM 链接问题：`);
  for (const p of problems) console.error('  ✖ ' + p);
  process.exitCode = 1;
} else {
  console.log(`ESM 依赖图检查通过（${files.length} 个模块）`);
}
