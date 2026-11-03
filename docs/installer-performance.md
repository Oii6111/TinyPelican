# 安装性能

目标是在测试机器上首次安装和覆盖安装均不超过 180 秒。`scripts/benchmark-installer.cjs` 使用完整 `app/dist/win-unpacked` 载荷、独立应用标识和临时安装目录实测；每次安装超过 180 秒即失败，不接触正式用户数据目录。

标准构建命令：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1 -SkipVendorInstall -SkipAppInstall`。脚本使用一级压缩，NSIS 关闭差分打包，避免差分模式把压缩级别强制恢复为最高级别。不要用无压缩代替性能验证。

构建后处理把字节内容完全相同的 zod 副本共享到 `@deepseek-ai/node_modules/zod`，逐个核对 Node 的依赖解析路径；不同内容的副本保留。打包过滤类型声明和标准 README、CHANGELOG、HISTORY 文件，保留运行模块及插件提示文档。

默认解压流程先写入临时目录，再逐项复制到安装目录。`scripts/installer-extract.nsh` 保留临时解压，使用 Windows robocopy 并行移动，检查退出码并在移动失败时终止。旧文件清理使用 Windows 长路径前缀，避免深层插件文件导致覆盖安装失败。

2026-10-28 完整载荷隔离实测：首次安装 47.459 秒，覆盖安装 102.265 秒，均退出 0；包约 247 MiB。这里计时截止安装器完成，不包含应用启动、DSH 首次初始化及模型网络请求。不同硬盘、杀毒软件和系统负载仍会影响耗时，不能据此承诺所有电脑必定低于三分钟。
