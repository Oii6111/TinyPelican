# Windows 安装包构建与验证

在普通用户终端运行 `npm run dist`。构建文件保留在 `app/dist`，可运行和分发的安装包默认导出到用户下载目录的 `TinyPelican` 子目录，并附带 SHA-256 校验文件。

部分受限工作目录具有 Windows 低完整性标签。直接双击其中的 EXE，安装器也可能以低完整性运行，无法修改正常的安装目录。旧版卸载失败后，electron-builder 会显示“应用无法关闭”，即使没有应用进程。

## 为什么会报“应用无法关闭”

2026-10-25 使用独立应用标识、小型安装夹具实际复现了两个故障：

1. 按 `Path.StartsWith($INSTDIR)` 强杀全部进程，会杀死在安装目录内运行的卸载器，实测退出码为 `0xFFFFFFFF`。现在外壳仍按镜像名关闭，后台只匹配本安装的 `resources\content\runtime\node.exe`，不再匹配卸载器；PowerShell 清理命令设置 15 秒无输出超时。
2. electron-builder 26.15.3 的 `un.atomicRMDir` 使用 `$R0\$R2` 比较卸载文件名。在根目录，左边是 `\Uninstall …exe`，右边没有开头的反斜杠，因此无法识别正在运行的卸载器自身。原地升级卸载实测返回 `2`，失败文件日志明确指向卸载器。自定义文件移动函数在根目录按文件名排除自身，其他文件移动失败时仍回滚并报错。

修复后同一夹具的首次安装、覆盖安装、原地升级卸载均返回 `0`。安装器重试旧卸载失败时使用“应用无法关闭”作为通用提示，不能仅凭该提示判断后台有应用进程，也不是安装器与卸载器共用 PID。

2026-10-25 正式包重新构建并导出后，使用下载目录中的 EXE 对本机 `AppData\Local\Programs\xiaotihu` 执行静默覆盖安装，退出码为 `0`。安装目录中重新生成 `Uninstall 小鹈鹕.exe`，内置 Node 存在。升级前后 852 个用户数据文件的路径及内容整体 SHA-256 均为 `3fdd831e4e37fd6ecaf75b3feeb2cab380b81d8bc92b0cdfb97d7c6a5b2504e0`。构建目录与下载目录 EXE 的 SHA-256 一致。

`customInit` 处理失效的旧卸载注册表记录。构建保持 electron-builder 默认的 7z 路径，不在 include 中硬编码 `APP_BUILD_DIR`：硬编码会绕过 `prepackaged` 测试夹具，误打入完整应用。之前的 ZIP 尝试还曾产生 Zip64 归档，旧 NSIS ZIP 插件无法读取；该方案已撤回。

快速真实回归：`node scripts/diagnose-installer.cjs`。每个安装/卸载子进程最多等待 30 秒；测试使用独立临时目录和应用标识，并检查升级保留模拟用户数据。任何排查命令连续四分钟无进展应停止并检查，不以长时间等待代替诊断。全量安装包仍须另外做真实覆盖验证，不能用小夹具通过代替。

检查交付时必须对比构建目录与下载目录安装包的 SHA-256。同名、同版本不表示同一产物；本次检查时两处安装包大小分别为 917,866,727 和 324,021,409 字节，哈希不同。

`node --test tests/installer-nsis.test.js` 对以上约束做静态校验。

`scripts/export-installer.ps1` 将安装包内容写入下载目录中的新文件，校验内容一致，并继承目标目录的文件权限。它不修改工作目录的安全设置。需要更改导出位置时，向构建脚本传入 `-InstallerExportDirectory`，选择普通用户可写、没有低完整性标签的目录。

已有构建无需重新压缩，可单独导出：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-installer.ps1 -InstallerPath app/dist/TinyPelican-Setup-0.1.0.exe
```

在普通用户终端执行 `node scripts/verify-installer.cjs` 可验证中文进程名关闭、升级卸载保留数据和普通卸载清理数据。测试使用系统临时目录、独立应用标识和模拟数据；隔离测试不能替代真实安装目录的升级验证。检查真实故障时，应同时核对实际安装器的进程权限、安装目录、卸载退出码和升级前后的用户数据。
