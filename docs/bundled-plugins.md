# 随包插件依赖

Windows 安装包必须同时包含市场入口 `agent/dsh-plugins/tinypelican-market` 和 `packaging/vendor/node_modules/dshmarket` 及其运行依赖。仅在 web profile 的 `bundles` 中登记 `dshmarket`，不会安装这个包。

`packaging/vendor/package.json` 固定市场版本，构建前通过 `npm install --prefix packaging/vendor` 准备依赖。即使使用 `-SkipVendorInstall`，构建脚本也会检查市场清单、后端入口、前端入口和 bundle 补丁，缺失时终止构建。

## 为什么光有 vendor 目录还不够

DSH 给 profile 做模块解析时是「两段式」，但**安装作用域不是「安装目录里有什么」**，而是顺着 `@deepseek-ai/dsh` 自己的 `dependencies` 走一遍依赖图
（`dsh-app-boot` 的 `collectInstallationScopePackages`）。`dshmarket` 只是被放在 `vendor/node_modules` 里当邻居、并不在那张图里，
于是 profile 的 `bundles` 一登记就解析不到，DSH 启动报：

```
dsh: warning: 1 entry did not activate
dsh-market (dshmarket): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dshmarket'
  imported from C:\Users\<用户>\AppData\Roaming\xiaotihu\dsh-home\profiles\web\
```

所以必须把随包市场包写进**内置 DSH 的 `dependencies`**：

- 构建时：`scripts/patch-vendor-dsh.js`（`build-installer.ps1` 会调用）→ 写进 `packaging/vendor/node_modules/@deepseek-ai/dsh/package.json`；
- 运行期：`ensureBundledPlugins()` 启动 DSH 前再修一次（`ensureInstallationDependencies`），幂等；
  已装好的旧版本会在下次启动时自愈，不需要重装。

写回一律是**无 BOM 的 UTF-8**：DSH 用 `JSON.parse` 读这份清单，带 BOM 会直接启动失败。

## 其它约定

启动时，市场依赖由内置 DSH 的安装作用域提供，不需要在用户电脑上再次联网安装。小鹈鹕自己的市场入口从随包源码复制到 profile 的 `node_modules`。用户为入口指定的其他依赖来源继续使用原安装流程。

安装目录不可写（例如装到受保护路径）时，依赖修补会失败并记一条 `warn` 日志，市场入口不出现，其它功能照常。

验证：

- `node --test tests/dsh-bundled-plugins.test.js` 覆盖认领逻辑（幂等、BOM、不可写、profile 未生成时的顺序）；
- 端到端复现：把 `app/dist/win-unpacked/resources/content` 当成安装目录，用全新 `DSH_HOME` 起一次 DSH 即可看到告警；跑一次自举后再起，告警消失。
