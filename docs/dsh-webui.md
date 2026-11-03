# 对话页面

左侧“对话”可展开或收起原生 DSH 工作区与会话列表，右侧显示对话主页面和详情面板。所有区域共享同一套 DSH React 运行实例及会话状态。切换其他页面保留对话页面和输入草稿。

首次进入时，小鹈鹕启动或复用 DSH，通过服务端交接 HttpOnly 登录 Cookie。连接失败时页面显示错误并提供重新连接。登录令牌不会放进页面 URL 或接口 JSON。

默认从 `http://127.0.0.1:18791` 打开小鹈鹕，内置 DSH 使用专用端口 `http://127.0.0.1:18792`，避免连接用户自行安装的 DSH 默认端口 3080。专用端口若已被其他进程占用，启动会明确报错。浏览器通过小鹈鹕的 `/dsh/` 同源入口加载 WebUI，HTTP 和 WebSocket 均经过登录校验、来源检查和固定目标代理。设置 `DSH_WEB_URL` 时，两者仍须使用相同主机名。代理使用服务端 DSH Cookie，不转发小鹈鹕会话凭据，也不向客户端透传上游 Cookie。

会话管理、文件上传、工具运行及审批使用 DSH 原生界面。原有聊天后端接口保留供微信等功能使用；在原生界面中新建会话时，消息直接交给 DSH，不经过小鹈鹕原来自制聊天页的逐条上下文拼接流程。

## 布局和设置

`core/agent/dsh-embed.js` 对经过代理的前端模块做版本受控的布局适配。`dashboard/src/dsh-embed.js` 使用 React Portal，将侧栏和设置分组挂载到父页面的 Shadow DOM；同步主题样式并处理跨文档菜单、键盘事件和窗口尺寸变化。对话主页面保留在 iframe 中，原生右侧栏继续使用 DSH 的布局计算。用户文件、邮件和 API 返回的 HTML 不参与页面改写。

左下角“设置”是唯一设置入口。DSH 注册的配置分组动态加入同一窗口的“对话与 Agent”区域，点击一个分类只显示一个配置部分。模型、插件、预设继续使用原有读写流程；切换分类保留已挂载的表单。对话外观跟随小鹈鹕，字号等偏好保留。第三方扩展设置加载失败时显示明确提示，其他设置仍可使用。

界面品牌、空白对话欢迎语及配色统一为小鹈鹕；实际模型供应商名称保留。DSH 原始 MIT 许可见 `licenses/DeepSeek-Harness-MIT.txt`，安装资源包含该文件。

## 随包插件与插件市场入口

产品自带一个 profile 级 DSH 插件 `agent/dsh-plugins/tinypelican-market`，目的是让用户在侧栏「插件」页里就能装插件，不必记命令、也不必离开页面：

- 它往「添加插件」箭头菜单（宿主的 `plugins.add.actions` 公开 slot）末尾加一项**从插件市场安装**，排在「安装第三方插件」「让 Agent 创建插件」之后；点开是一个大弹窗，里面就是插件市场本体的页面——市场（npm 包 `dshmarket`）通过 `ctx.provide('market')` 把面板交出来，弹窗只负责装下它。市场没在跑时弹窗给出说明，而不是让菜单项消失。
- 弹窗不带自己的安装逻辑：安装、更新、卸载、重启提示全部走市场原本的界面和它自己的服务端路由，行为与设置里的「插件市场」一致。

「随包」不是把插件塞进 DSH 自己的 `node_modules`（那归上游所有、升级会被覆盖），而是跟着产品分发、注册进用户 profile：插件源码随安装包进入 `resources/content/agent/dsh-plugins/`，`core/agent/dsh-bundled-plugins.js` 在每次拉起 DSH 之前把它同步到 `$DSH_HOME/profiles/web/plugins/`，在 profile 的 `package.json` 里补上 `file:` 依赖与 bundle，再用 `dsh plugin install` 让 pnpm 建好链接。只在内容或登记有变化时才跑安装；任何失败只写日志，不挡 DSH 启动，最多少一个入口。这台机器上的插件市场本身（`dshmarket`）仍是普通 profile 依赖，用户可以在插件页里照常升级、停用或换源。

## 升级验证

当前适配基于 DSH `0.2.1-rc.2`，主依赖与 `packaging/vendor` 均固定为此版本。适配只影响 `/dsh/` 返回的前端资源，不修改安装目录中的上游文件。关键结构不匹配时拒绝加载并提示兼容问题，避免静默丢失会话操作。升级或未来打包前需确保实际运行的 DSH 与此版本一致，并运行 `node --test "tests/dsh-*.test.js" tests/start-dsh-settings.test.js tests/settings-ui.test.js`。本次没有执行打包；现有安装版需要重新打包、安装才能使用新版内置 DSH。

## 模型地址与协议

小鹈鹕设置中的官方 DeepSeek 地址为 `https://api.deepseek.com`。DSH 通过 `llm-deepseek` 使用 Messages 协议，自动映射到 `https://api.deepseek.com/anthropic/v1/messages`，旧配置中的官方 `/v1` 地址也按此规则处理。小鹈鹕自身的模型调用继续使用 OpenAI 兼容接口。

第三方兼容服务使用 `llm-pi-ai` 的 `openai-completions` 协议，保留所填地址中的 `/v1`，例如 `https://gateway.example/v1` 请求到 `/v1/chat/completions`。不能把这种地址直接交给新版 `llm-deepseek`，否则会错误请求 `/v1/messages` 并返回 404。

核心启动器和手动诊断启动器共用 `core/agent/dsh-provider.js` 生成路由。密钥通过 `TINYPELICAN_MODEL_API_KEY` 传入子进程，并保留 `DEEPSEEK_API_KEY` 兼容；生成的 `settings.yaml` 不写入密钥明文。同步时保留其他供应商、插件设置和推理等级。新版 Agent preset、欢迎确认、前端入口与 WebUI 启动配置同步适配。
