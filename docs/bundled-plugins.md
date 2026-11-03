# 随包插件依赖

Windows 安装包必须同时包含市场入口 `agent/dsh-plugins/tinypelican-market` 和 `packaging/vendor/node_modules/dshmarket` 及其运行依赖。仅在 web profile 的 `bundles` 中登记 `dshmarket`，不会安装这个包。

`packaging/vendor/package.json` 固定市场版本，构建前通过 `npm install --prefix packaging/vendor` 准备依赖。即使使用 `-SkipVendorInstall`，构建脚本也会检查市场清单、后端入口、前端入口和 bundle 补丁，缺失时终止构建。

启动时，市场依赖可从内置 DSH 的安装目录解析，不需要在用户电脑上再次联网安装。小鹈鹕自己的市场入口从随包源码复制到 profile 的 `node_modules`。用户为入口指定的其他依赖来源继续使用原安装流程。

DSH 的 bundle 解析顺序是安装目录优先、profile 次之，因此随包市场版本由应用升级更新。已有 profile 里的市场依赖记录会保留，但不会覆盖随包版本。其他用户自行添加的插件仍可能需要联网安装。

验证：`node --test tests/dsh-bundled-plugins.test.js` 包含离线修复回归，用不存在的 CLI 路径确保准备随包插件时不会运行安装命令。
