'use strict';

// 随包依赖（@deepseek-ai/*）实际装在 packaging/vendor/node_modules，
// 早期测试直接指向仓库根的 node_modules。这里统一解析，避免布局变动后到处改路径。

const fs = require('node:fs');
const path = require('node:path');

const DSH_VENDOR_ROOTS = [
  path.resolve(__dirname, '../packaging/vendor/node_modules'),
  path.resolve(__dirname, '../node_modules'),
  path.resolve(__dirname, '../app/node_modules')
];

function dshVendorPath(...segments) {
  for (const root of DSH_VENDOR_ROOTS) {
    const candidate = path.join(root, ...segments);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到随包依赖 ${segments.join('/')}；已查找：${DSH_VENDOR_ROOTS.join(' ; ')}`);
}

module.exports = { dshVendorPath, DSH_VENDOR_ROOTS };
