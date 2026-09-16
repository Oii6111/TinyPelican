# 微信聊天记录批量导入

> 对应版本：2026-09（微信 4.x「导出聊天记录」+ 小鹈鹕导入管线）

## 一块拼图：微信怎么把文件交给我们

微信 4.x 的「转发到其他应用」走的是 **Windows 分享面板**（UWP `windows.shareTarget` 合约）。判断依据：

- 分享面板里列出的应用（Outlook、手机连接、Microsoft Copilot）**都是打包（MSIX/UWP）应用**；
- 这类列表只读取**已注册包标识**的应用扩展，不读注册表里的「发送到 / 右键菜单」，也不存在对应的 COM 接口。

所以结论很关键：

| 方案 | 能否出现在微信「转发到其他应用」 | 需要什么 | 小鹈鹕现状 |
|------|--------------------------------|----------|-----------|
| 经典 Win32：发送到 / 右键 / 拖到 exe | ❌ | 一个 .cmd + HKCU 注册 | ✅ 已实现（`scripts/register-import-handler.ps1`） |
| 分享面板（ShareTarget） | ✅ | **MSIX 包标识** + `windows.shareTarget` 扩展 + 能接收 ShareTarget 激活的处理器（WinRT） | ⏳ 待定（见下） |

## 已实现的导入管线（与传输方式无关）

无论文件是「发送到」过来的、被 shim 投递的，还是手工跑的，都走同一条管线：

```
ZIP / TXT / CSV / JSON
        │  core/import/chat-archive.js
        ▼
  识别格式 → 解析消息 → 按联系人归档 → SQLite（自动去重）
```

三种入口：

```powershell
# 1) 命令行（也可作为任何外部程序的落地点）
npm run import -- "C:\Users\me\Downloads\微信聊天记录.zip"
npm run import -- "C:\导出目录" --dry-run          # 只解析不入库

# 2) HTTP（核心运行时）
POST http://127.0.0.1:18791/api/import/archive
{ "paths": ["C:\\...\\微信聊天记录.zip"], "intents": true }

# 3) 资源管理器：右键 / 发送到（注册一次即可）
powershell -ExecutionPolicy Bypass -File scripts\register-import-handler.ps1
```

细节：

- **压缩包在内存里解压**，不往磁盘写文件；拒绝路径穿越（`..`）与加密条目，并带解压炸弹防护（单条 64MB / 整包 512MB 上限）。
- **去重**靠 SQLite 里的 `member + 发送者 + 时间 + 类型 + 内容` 哈希，同一份导出重复导入不会产生重复消息。
- **联系人**优先取消息里唯一的非自己昵称（`selfNicknames`），拿不到再用文件名推断（`与张三的聊天记录.txt` → 张三）。
- 识别不了的文件不会静默丢弃：结果里会给 `unparsed` / `unsupported` 状态和内容预览（方便补格式）。

## 分享面板（ShareTarget）路线 —— 已实现

微信「转发到其他应用」的列表里现在可以出现 **「小鹈鹕 · 聊天记录导入」**，整套东西在这里：

```
packaging/share-target/
  AppxManifest.xml                     # 声明 windows.shareTarget（StorageItems + .zip/.txt/.csv/.json/.jsonl）
  TinyPelicanShareTarget/Program.cs    # shim：接住分享文件 → 调 core/import/chat-archive.js
  install-share-target.ps1             # 构建 + 注册（-Unregister 卸载）
  layout/                              # 构建产物（gitignore）
```

安装 / 卸载：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\share-target\install-share-target.ps1
powershell -ExecutionPolicy Bypass -File packaging\share-target\install-share-target.ps1 -Unregister
```

实测链路（本机已注册 `TinyPelican.ShareTarget_1.0.0.0_x64`，开发模式免签名）：

```
TinyPelicanShareTarget.exe --selftest "聊天记录_20260916_233405.zip"
→ 已导入到小鹈鹕记忆库：文件 1 个 / 解析 18 条 / 新增 18 条 / 归属「微信导出（未归属）」
→ SQLite：text=14、图片=1、文件=1、语音=1、链接=1
```

设计要点：

- shim 是**全信任打包应用**（`Windows.FullTrustApplication` + `rescap:runFullTrust`），只做「接文件 + 转交」，
  真正解析入库仍是 `core/import/chat-archive.js`（与命令行/HTTP 同一条管线）；
- 微信导出不含昵称，所以 shim 会先弹一个小窗问**这段记录属于谁**（留空 = 存入「微信导出（未归属）」，会记住上次填写）；
  也可以在程序目录的 `tinypelican.json` 里设 `askContact: false` 跳过；
- 卸载：`install-share-target.ps1 -Unregister`，或 `Remove-AppxPackage TinyPelican.ShareTarget_1.0.0.0_x64__*`。

### 分享面板路线的原始调研（保留备查）

要真正出现在微信那个列表里，需要三步，缺一不可：

1. **给应用一个包标识**：MSIX 全量包，或「稀疏包」（external location，保留现有 Electron 安装目录不改）。
   本机工具链已具备：Windows SDK 10.0.26100（`makeappx` / `signtool`）+ `dotnet` + **已开启开发者模式**（可免签名 `Add-AppxPackage -Register` 本地调试）。
2. **清单里声明分享目标**：`<uap:Extension Category="windows.shareTarget">`，声明接收 `StorageItems` 与 `.zip/.txt/.csv/.json` 等类型。
3. **接收激活并转交给我们**：Windows 把分享内容作为 `ShareTargetActivatedEventArgs` 交给应用的**打包入口**，
   Electron/Node 拿不到这个 WinRT 对象，所以需要一个很薄的 **原生 shim**（C#/.NET + Windows App SDK 的 `AppInstance.GetActivatedEventArgs()`，或 UWP/WinUI 小应用）：
   它只做一件事——把 `DataPackageView` 里的文件落到临时目录，然后调用
   `node core/import/chat-archive.js <files>`（或 POST `/api/import/archive`）。

待确认/依赖：

- 需要安装 NuGet 包 `Microsoft.WindowsAppSDK`（首次要联网）；
- 若 Windows 不给「全信任打包应用」投递 ShareTarget 激活，则要退回到 UWP/WinUI shim（需要 UWP 工作负载）；
- 分发方式会随之改变（安装包/证书），属于产品决策。

**当前建议**：先用「发送到 / 右键」这条路跑通导入（今天就能用），分享面板那条按上面的清单单独排期。
