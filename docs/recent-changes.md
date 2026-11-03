# 近期功能更新

## 修复安装包启动时的 dsh-market 告警（2026-11-04）

- 现象：装完包启动 DSH 报 `dsh: warning: 1 entry did not activate` / `dsh-market (dshmarket): Cannot find package 'dshmarket'`，侧栏少一个插件市场入口。
- 原因：DSH 的「安装作用域」不是「安装目录里有什么」，而是顺着 `@deepseek-ai/dsh` 自己的 `dependencies` 走依赖图；`dshmarket` 只是被放在 `vendor/node_modules` 里当邻居，不在图里，profile 一登记就解析不到。
- 修复：构建时（`scripts/patch-vendor-dsh.js`）和启动时（`ensureInstallationDependencies`）都把随包市场包写进内置 DSH 的 `dependencies`，写回是无 BOM 的 UTF-8；已装坏的旧版本在下次启动时自愈，不需要重装，也不动用户的 profile。
- 手工启动脚本 `scripts/start-dsh.js` 也走同一套自举，避免排查时再看到同一条告警。
- 用打包产物（`app/dist/win-unpacked`）实测：新装首启会打日志「随包插件：内置 DSH 已认领 dshmarket」，随后 DSH 不再出现该告警；6 项新测试覆盖幂等、BOM、不可写与首启顺序。

## 剪贴板聊天记录的图片与文件（2026-10-31）

- 微信复制带图片/文件的聊天时，附件不在剪贴板的位图里：`CF_HDROP` 给的是 `temp\RWTemp` 下已解密的明文文件，私有格式 `x-xwechat-multiselect-copy` 的 item 数组给出「第 i 项 ↔ 第 i 条消息」的映射。
- 剪贴板传感器新增 `MEDIA` 行（位于 `CHANGE` 之前），带出文件清单与该映射；Node 侧按整段聊天配对，多图不再依赖文件名。
- 附件落到 `<数据目录>/media/chat/`，按 sha256 命名，库里的 `message_attachment` 只存相对路径；同一份内容只存一次，跟临时目录彻底脱钩。
- 首次导入时生成一次描述并存库：图片用配置的视觉模型写一句内容描述（含图中关键文字），没有视觉模型时退化成元数据描述（类型/文件名/格式/大小/尺寸）并提示用户单独配置视觉模型；文件类只做元数据 + 文件名推断（PDF 附页数），不抽正文。
- 设置 → 模型服务新增「图片描述用的视觉模型」：默认跟随当前模型，也可以单独指定服务商与模型；页面直接显示此刻实际是谁在识图（判定逻辑在后端 `/api/engine/vision`，前端不复制一份规则）。
- 新增 `GET /api/contacts/attachment/:id` 提供预览与下载；联系人页附件卡片显示描述，agent 回读聊天时直接拿到这段文字。实测 `deepseek-flash` 看图约 1 秒；同一张图在别处描述过就直接复用，重复复制不落盘也不重复调用模型。
- 全程只读剪贴板，不打开、不解密微信数据库或 `.dat`。裁剪后的归档（超过保留期的消息）同时清理附件文件，不留孤儿。
- 20 项新增/更新测试覆盖多图配对、落盘去重、描述生成与退化、整链路入库；全量 59 个测试文件通过。

## DSH 0.2.1-rc.2 升级（2026-10-22）

- 主依赖与安装包 vendor 同步升级至 `0.2.1-rc.2`；适配新版 Agent preset、前端入口与 WebUI 启动配置。
- 官方 DeepSeek 配置地址统一为 `https://api.deepseek.com`，DSH 使用 `/anthropic/v1/messages`。
- 第三方 OpenAI 兼容服务改用 `llm-pi-ai`，保留 `/v1` 并请求 `/chat/completions`，避免 Messages 请求走错地址导致 404。
- 核心和诊断启动器共用协议路由，保留外部供应商设置与推理等级；密钥通过环境变量传入。
- DSH 相关 39 项测试通过；临时数据目录中的新版 Web preset 配置合成、实际服务启动及登录后页面 HTTP 200 验证通过。146 个文件语法检查通过；全量 252 项测试中 251 项通过，剩余失败为本地生成的 `output/product-guide/render_document.ps1` 缺少 UTF-8 BOM。本次未重新打包，未进行真实模型付费调用。

本次提交汇总自上次提交以来积累的功能、界面、测试和文档改动。

## 对话与 Agent

- 对话页接入 DSH 原生界面，统一会话导航、设置入口、主题和品牌。
- 通过同源 HTTP/WebSocket 代理接入 DSH，登录交接使用服务端 Cookie。
- 调整模型能力与配置同步、Agent 系统指引、主会话转向、启动与兼容逻辑。
- DSH 固定为 `0.2.1-rc.2`，升级前需验证前端适配；许可位于 `licenses/DeepSeek-Harness-MIT.txt`。

详见[对话页面说明](dsh-webui.md)。

## 微信与邮件

- 微信渠道支持图片与文件上传、接收、下载、显式发送和错误反馈。
- Agent 可按既有媒体指令发送允许范围内的生成文件。
- 邮件模块提供 IMAP 同步、解析、分类、摘要、待确认行动候选、SMTP 发送及联系人邮箱关联。
- 邮件凭据通过本地设置配置；模板不包含真实账号密码。关联邮箱采用精确匹配，歧义需手动处理。
- 可选邮件插件由 `scripts/install-dsh-email.ps1` 获取固定上游提交并应用兼容调整，安装目录 `agent/dsh-email` 不重复纳入主仓库；安装流程见 `agent/README.md`。

详见[微信图片和文件收发](weixin-media.md)。

## 页面与视觉

- 联系人页使用无头像布局、按日期分组的只读消息、可编辑画像卡片和独立数据管理区。
- 日期筛选和聊天文本导出只作用于当前已加载的记录。
- 消息渠道、待办、待确认、记录、日历和设置页面同步调整布局、分组及状态反馈。
- 桌面标题栏、托盘与退出逻辑及安装资源更新。

详见[联系人界面使用与开发说明](contacts-ui.md)。`settings-inventory.md` 保留设置整理过程中的盘点，不作为当前导航结构的唯一依据。

## 开发与验证

- 新电脑部署要求 Node.js 22.13+；核心启动前会选择可写数据目录并自动创建缺失的 config.json。
- Electron 用户数据目录支持权限受限时回退；PowerShell 启动器轮询 /api/health，确认核心就绪后再打开页面。
- 详细步骤见[新电脑部署说明](deployment.md)。

```powershell
npm install
npm run check
npm test
```

本次变更补充了 DSH 嵌入与代理、邮件、微信媒体、设置、主会话转向及联系人界面的回归测试。

2026-10-17 本地验证：142 个文件语法检查通过；全量测试共 208 项，204 通过、4 失败。失败项为 `contact-delete.test.js` 的 Windows 临时目录清理权限、`pipeline.test.js` 和 `voice.test.js` 的测试流水文件缺失，以及 `weixin-media-ui.test.js` 中旧 DSH 页面地址断言。联系人界面三项回归测试均通过，宽屏和窄屏浏览器检查通过。以上失败未在本次提交中额外修复。

部署与测试修复后复验：144 个文件语法检查通过，全量测试 211 项全部通过。联系人测试在清理前关闭 SQLite 连接；消息归档与语音回填测试改为验证 SQLite 数据和去重；DSH 页面测试按同源代理与就绪事件验证，并覆盖异源地址拒绝。

本地数据库、凭据、聊天记录继续忽略；`tmp/` 和 `output/` 为本地材料与预览产物，不随源码提交。没有执行安装包构建。

## 打包版 PowerShell 弹窗

- 打包版「一用工具就疯狂弹 PowerShell 窗口」已修：核心改为跑在随包的 `node.exe` 上（`resources/content/runtime/node.exe`，构建时从构建机复制）。
- 原因：`electron.exe` 是 GUI 子系统程序，当 Node 用时整棵进程树没有控制台；DSH 用它自带的 `windows-job` runner（原生 `CreateProcessW`，不带 `CREATE_NO_WINDOW`）拉起 `pwsh.exe`，系统就给每条命令新建一个可见控制台窗口。开发版整条链是终端里的 `node.exe`，控制台被继承，所以从没暴露。
- 旧的 `windowsHide: true` 只盖住我们自己 spawn 的进程，管不到 DSH 内部；现在隐藏控制台由 `node.exe` 一路继承给 DSH / runner / pwsh。细节见 `core/lib/runtime-node.js`，`ARCHITECTURE.md` 的「Node 运行时」条目同步更新。
- 老安装目录没有 `runtime/node.exe` 时退回 `ELECTRON_RUN_AS_NODE`（弹窗会回来）；要拿到修复必须重新打包/重新安装。

## 意图识别的触发收口

- 复制一条消息不再立刻触发一轮全量扫描：`requestIntentExtraction` 先等 `intent.debounceMs`（默认 2500ms）内没有新触发才扫描，连续复制多条消息合并成一轮，且这一轮包含全部新消息。
- 两轮扫描之间至少间隔 `intent.minIntervalMinutes`（默认 1 分钟，设置页「高级与排障 → 触发冷却」）。冷却期内的触发排队到点再跑一轮，不丢也不叠加；扫描进行中来的触发在结束后补一轮，不会并发扫描。此前这个配置项存在但没有任何代码读取。
- `intent.highConfidence`（默认 0.85）现在对聊天意图生效：≥ 阈值且能落成具体事项（日程有开始时间、提醒有时间或重复规则）的直接建成正式任务/日程，并推一条「已创建事项」通知；需要 Agent 执行的动作（`execution.mode = 'dsh'`）一律留待确认。此前只有邮件分析使用该阈值，设置页文案与实现不符。
- 设置页文案对齐实现：剪贴板轮询间隔默认值改为 400ms；「已自动创建」状态在待确认页有中文标签。
- 回归测试：`tests/intent-scheduler.test.js`（合并、冷却、补跑、自动创建、阈值可调），`tests/intent-context.test.js` 保留原判定并显式调高阈值。

## 连续复制不丢批次

- 修掉剪贴板批次的丢弃路径：`core/capture/clipboard.js` 原来是「覆盖定时器」，250ms 静默窗口内连着复制两段不同聊天时，前一批的新消息会被直接丢掉，而且它们已进了去重集合 `seen`，等于永久丢失。现在改为**排队**：窗口内每批都入队，窗口结束按复制顺序逐批交付，逐批 `try/catch` 兜住（一批出错不影响后面的批次）。
- 同一段聊天在被交付前重复上报（传感器抖动 / 连按两次）只算一次，保留先到那批的入库内容，不会变成「归档一次 + 再要一次建议」；不同内容永远不合并。
- `stop()` 会先把排队未交付的批次交付出去，再关传感器：停监听（关应用/热重启）时最后一次复制不丢。
- 仍有一个物理限制：剪贴板是轮询读取的，两次复制间隔小于 `pollMs`（默认 400ms）时，剪贴板里只剩最后一次内容，任何轮询实现都拿不到中间那次；手速正常的连续复制远大于这个间隔。
- 回归测试：`tests/clipboard-burst.test.js`（窗口内两段不同聊天都入库且归属正确、同一联系人三段顺序不乱、重复上报不挤掉别的批次、停止监听先落库、非聊天文本仍不入库）。意图扫描仍在归档之后按合并/冷却排队，不影响入库。

## 回复建议浮窗的定位与可见性

- 现象：复制聊天后建议窗「没弹」，实际是弹到了屏幕右下角并被最大化窗口盖住。排查证据：建议已生成（`activity.log` 有 `已生成回复建议`）、`/api/reply-suggestions/current` 有建议、窗口 `IsWindowVisible=true` 但 `anchor=null`，坐标正好是「主屏右下角」兜底位置；2 分钟（`expireSeconds`）后按设计自动隐藏。
- 原因一：微信窗口识别只认 `WeChat` / `Weixin`，微信 4.x 用 `WeChatAppEx` 承载独立聊天窗口时被当成「非微信」，矩形不采用 → 没有锚点。现在 `isWeixinProcess()` 一并识别 `WeChatAppEx`（以及带 `.exe` 的变体），`refresh-position` 也复用同一判断。
- 原因二：最小化的窗口会被 Windows 停在 -32000 附近，旧逻辑只看「右下大于左上」，会拿这种矩形算出屏幕外的锚点。新增 `usableWindowBounds()`：坐标越界（<-10000）、宽高非正、尺寸异常的矩形一律判为不可用。
- 兜底改为贴鼠标：拿不到锚点时用 `screen.getCursorScreenPoint()` 定位（刚复制完鼠标就在聊天窗口里），不再甩到屏幕角落；显示后调用 `moveTop()`，用户正停在别的最大化窗口时也不会被盖住。
- 诊断：复制时若有句柄却定位不了，`activity.log` 会记一条「窗口未识别，建议卡片不使用微信定位：process=… rect=…」，下次能直接看出漏了哪个进程名。
- 回归测试：`tests/reply-anchor.test.js`（进程识别、无效矩形、WeChatAppEx 带上矩形、最小化/非微信不带矩形、锚点坐标、无矩形时 anchor 为空但可粘贴）。
