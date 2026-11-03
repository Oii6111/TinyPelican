// 构建时修补：把随包市场包写进内置 DSH 的 dependencies。
//
// 原因见 core/agent/dsh-bundled-plugins.js 里 ensureInstallationDependencies 的注释：
// DSH 的「安装作用域」是顺着 @deepseek-ai/dsh 的依赖图算出来的，
// vendor/node_modules 里多放一个 dshmarket 并不会让它被解析到。
//
// 用法：node scripts/patch-vendor-dsh.js [dshBin]
'use strict';

const path = require('node:path');
const { ensureInstallationDependencies } = require('../core/agent/dsh-bundled-plugins');

const dshBin = path.resolve(process.argv[2] || path.join(
  __dirname, '..', 'packaging', 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'
));

const result = ensureInstallationDependencies({ dshBin });
if (result.error) {
  console.error('内置 DSH 依赖修补失败：' + result.error);
  process.exit(1);
}
console.log(result.changed
  ? `内置 DSH 已认领随包市场包：${result.added.join('、')}（${result.manifestPath}）`
  : '内置 DSH 依赖已就绪');
