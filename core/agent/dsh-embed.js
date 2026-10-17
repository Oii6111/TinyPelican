'use strict';

const EMBED_PREFIX = '/dsh/';

function replaceRequired(source, before, after) {
  if (!source.includes(before)) throw new Error('当前 DSH 前端版本与小鹈鹕布局适配不兼容，请更新适配后重试。');
  return source.replace(before, after);
}

// 正则版：命中不了同样抛错（文案里带可选写法时用）
function replaceRequiredPattern(source, pattern, after) {
  if (!pattern.test(source)) throw new Error('当前 DSH 前端版本与小鹈鹕布局适配不兼容，请更新适配后重试。');
  return source.replace(pattern, after);
}

// 尽力而为版：**不抛错**。只用在"改不掉只是露出品牌字样、但抛错会让整个界面打不开"的地方
// （shell bundle = 应用本体、设置页模块 = 功能入口）。这类字面量由 tests/dsh-embed.test.js
// 对着随包资源钉住：上游改文案时是**测试失败**，而不是线上白屏。
function replaceBestEffort(source, before, after) {
  return source.includes(before) ? source.replace(before, after) : source;
}

function replaceBestEffortPattern(source, pattern, after) {
  return pattern.test(source) ? source.replace(pattern, after) : source;
}

function transformHtml(source) {
  return source
    .replace(/<base\s+href="[^"]*"\s*\/?\s*>/i, '<base href="/dsh/">')
    .replace(/(["'])\/plugins\//g, '$1/dsh/plugins/')
    .replace(/<title>[^<]*<\/title>/i, '<title>小鹈鹕</title>')
    .replace(/<link\b[^>]*rel="(?:icon|manifest)"[^>]*>/gi, '')
    .replace('<head>', '<head><script src="/src/dsh-embed.js"></script><link rel="icon" href="/logo.png"><link rel="stylesheet" href="/src/dsh-embed.css">');
}

function transformScript(source) {
  return source.split(/(?=window\.__ModuleLoader__\.load\(\{)/).map(transformModule).join('');
}

function transformModule(source) {
  let result = source;
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-open-in-app"')) {
    result = replaceRequired(result, 'const OPEN_IN_APP_ICON_PREFIX = "/open-in-app/icon";', 'const OPEN_IN_APP_ICON_PREFIX = "/dsh/open-in-app/icon";');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-layout"')) {
    result = replaceRequired(result,
      'const s = sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);',
      'const s = window.__TP_EMBED__.hasSidebar() ? 0 : sidebar === 0 ? 56 : clampWidth(sidebar, 264, 420);');
    result = replaceRequired(result,
      'const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;',
      'const sidebarCollapsed = window.__TP_EMBED__.hasSidebar() || (narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0);');
    result = replaceRequired(result, '}, AppFrame);', '}, window.__TP_EMBED__.wrapLayout(AppFrame, react, require("react-dom")));');
    result = replaceRequired(result, 'const productTitle = "DeepSeek Harness";', 'const productTitle = "小鹈鹕";');
    result = replaceRequired(result, 'const scheme = snapshot.active.colorScheme;', 'const scheme = "light";');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-sidebar"')) {
    result = replaceRequired(result,
      'className: SidebarRoot_module_css_default.logoRow,',
      'className: SidebarRoot_module_css_default.logoRow, "data-tp-brand-row": true,');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-conversation"')) {
    result = replaceRequiredPattern(result, /"hero\.headline": "(?:探索未至之境|探索未知之境)"/g, '"hero.headline": "今天想做点什么？"');
    result = replaceRequired(result, 'className: HeroShell_module_css_default.previewBadge,', 'className: HeroShell_module_css_default.previewBadge, "data-tp-preview": true,');
    result = replaceRequired(result, '"hero.headline": "Into the Unknown"', '"hero.headline": "What would you like to do today?"');
    // 首屏徽标「预览版」：把文案清空，不再只靠 CSS 隐藏
    result = replaceBestEffort(result, '"hero.preview": "预览版"', '"hero.preview": ""');
    result = replaceBestEffort(result, '"hero.preview": "Preview"', '"hero.preview": ""');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-chat"')) {
    result = replaceRequired(result, '"chat.deepDiving": "深度求索中..."', '"chat.deepDiving": "小鹈鹕正在思考…"');
    result = replaceRequired(result, '"chat.deepDiving": "Deep diving..."', '"chat.deepDiving": "TinyPelican is thinking…"');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-settings-general"')) {
    result = replaceRequired(result, 'function apply(ctx) {', 'function apply(ctx) {\nctx.effect(() => ctx.slots.onEntryError((key, entry) => { if (key === "settings.section") window.__TP_EMBED__.settingsError(entry.options.id); }));');
    result = replaceRequired(result, '}, SettingsRoot));', '}, window.__TP_EMBED__.wrapSettings(SettingsRoot, react, require("react-dom"))));');
    result = replaceRequired(result,
      'className: clsx(SettingsRoot_module_css_default.triggerRow, !wide && SettingsRoot_module_css_default.railRow),',
      'className: clsx(SettingsRoot_module_css_default.triggerRow, !wide && SettingsRoot_module_css_default.railRow), "data-tp-settings-trigger": true,');
    result = replaceRequired(result, 'const openSection = (0, react.useCallback)((id) => {', 'const openSection = (0, react.useCallback)((id) => {\nif (window.__TP_EMBED__.openSettings(id)) return;');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-theme"')) {
    result = replaceRequired(result, '}, AppearanceRow));', '}, () => react_jsx_runtime.jsxs("div", { className: "tp-appearance-row", children: [react_jsx_runtime.jsx("span", { children: "外观" }), react_jsx_runtime.jsx("span", { children: "跟随小鹈鹕" })] })));');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-brand-official"')) {
    result = replaceRequired(result,
      'return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FishLogo, { size });',
      'return (0, react_jsx_runtime.jsx)("img", { src: "/logo.png", alt: "", width: size, height: size });');
    result = replaceRequired(result,
      'return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.BrandWordmark, { includeMark: false });',
      'return (0, react_jsx_runtime.jsx)("span", { children: "小鹈鹕" });');
    result = replaceRequired(result, 'function apply(ctx) {', 'function apply(ctx) {\nctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, () => (0, react_jsx_runtime.jsx)("img", { src: "/logo.png", alt: "小鹈鹕", width: 56, height: 56 })));');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-locale"')) {
    // 侧栏品牌位没有 occupant 时的 fallback 文案（"DSH 本地构建"）。正常情况下官方品牌行会占住，
    // 但那是"潜在"泄漏，顺手改掉。
    result = replaceBestEffort(result, '"brand.localBuild": "DSH 本地构建"', '"brand.localBuild": "小鹈鹕"');
    result = replaceBestEffort(result, '"brand.localBuild": "DSH Local Build"', '"brand.localBuild": "TinyPelican"');
  }
  if (source.includes('id: "@deepseek-ai/dsh-session-log-export"')) {
    // 「下载 Session 日志」的默认文件名
    result = replaceBestEffort(result, 'return `dsh-session-${', 'return `tinypelican-session-${');
  }
  if (source.includes('id: "@deepseek-ai/dsh-client-ui-settings-models"')) {
    // 设置页首屏的「内测声明」正文。正常路径由 core/agent/dsh-client.js 写 ui-onboarding 确认版本来
    // 压掉（那样整条模态都不出现）；这里是上游 bump 版本号时的兜底，只改文案。
    result = replaceBestEffortPattern(result, /welcomeBody: "DeepSeek Harness 0\.1 remains[^"]*"/, 'welcomeBody: "小鹈鹕 0.1 仍处在内测阶段，我们会持续打磨并欢迎反馈。"');
    result = replaceBestEffortPattern(result, /welcomeBody: "DeepSeek Harness 目前的 0\.1 版本[^"]*"/, 'welcomeBody: "小鹈鹕 0.1 仍处在内测阶段，我们会持续打磨并欢迎反馈。"');
  }
  if (source.includes('dataset.dshBootSpinner')) {
    // shell bundle（应用本体，加载时屏幕正中的 boot 卡）。
    // 这里**故意用尽力而为**：改不掉只是露出 "HARNESS" 字样，抛错却会让整个界面打不开。
    result = replaceBestEffort(result, 'this.wordmark=ot(rt.wordmark,"HARNESS")', 'this.wordmark=ot(rt.wordmark,"小鹈鹕")');
    result = replaceBestEffort(result, 'this.hint=ot(rt.hint,"Loading plugins\u2026")', 'this.hint=ot(rt.hint,"正在加载\u2026")');
  }
  if (source.includes('createPortal(') && source.includes('document.body') && source.includes('Menu:')) {
    result = result.replace(/\b([A-Za-z_$][\w$]*)\.createPortal\(/g, 'window.__TP_EMBED__.portal($1.createPortal,');
  }
  result = result.replace(/(["'])\/plugins\//g, '$1/dsh/plugins/');
  result = result.replace(/(["'])DeepSeek Harness\1/g, '$1小鹈鹕$1');
  return result;
}

module.exports = { EMBED_PREFIX, transformHtml, transformScript };
