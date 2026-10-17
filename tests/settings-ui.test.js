'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.nodeType = 1;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.value = '';
    // 真实 DOM 里复选框默认就是 false；少了这一行，JSON.stringify 会把 undefined 的勾选值整个丢掉
    this.checked = false;
    this.style = {};
    this.hidden = false;
    this.scrollTop = 0;
    this.classList = {
      toggle: (name, active) => {
        const names = this.className.split(' ').filter((entry) => entry && entry !== name);
        if (active) names.push(name);
        this.className = names.join(' ');
      }
    };
  }
  append(...children) {
    for (const child of children) {
      if (child.parent) child.parent.children = child.parent.children.filter((entry) => entry !== child);
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatchEvent(event) {
    // 属性式 onclick（组件里常用 `btn.onclick = ...` 赋值）也要能被派发到
    if (event.type === 'click' && typeof this.onclick === 'function') this.onclick(event);
    for (const callback of this.listeners[event.type] || []) callback(event);
    return true;
  }
  all() { return [this, ...this.children.filter((child) => child instanceof Element).flatMap((child) => child.all())]; }
  querySelectorAll(selector) {
    return this.all().slice(1).filter((entry) => selector.startsWith('.')
      ? entry.className.split(' ').includes(selector.slice(1))
      : entry.tagName === selector);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// 方案 A 的信息架构：一个用户问题 = 一个分组；板块用 id 归组，新增板块必须显式挂进某组。
// 「双向渠道」是一个板块 + 三个子页面（微信 / 邮件 / 通知），旧链接用子页面 id 直接跳转。
const GROUPS = [
  ['连接与账号', ['model', 'channels', 'web-search']],
  ['记忆与画像', ['capture', 'contacts']],
  ['回复与表达', ['reply-suggestions']],
  ['主动与提醒', ['proactive']],
  ['高级与排障', ['advanced']]
];
const CHANNEL_SUBTABS = ['wechat', 'email', 'notify'];

test('settings switches one panel at a time, preserves drafts, and handles channel shortcuts', async () => {
  const previous = { document: global.document, fetch: global.fetch, sessionStorage: global.sessionStorage };
  const storage = new Map();
  global.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text })
  };
  global.sessionStorage = { getItem: (key) => storage.get(key) || null, removeItem: (key) => storage.delete(key) };
  global.fetch = async () => new Response(JSON.stringify({}));
  let view;
  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/settings.mjs')).href);
    const root = new Element('div');
    view = mount(root);
    const panels = root.querySelectorAll('.settings-section');
    const buttons = root.querySelectorAll('.settings-modal-nav-item');
    const content = root.querySelector('.settings-modal-content');
    const subtabsOf = (panel) => panel.querySelectorAll('.settings-subtab');
    const activeSubtab = (panel) => {
      const active = subtabsOf(panel).filter((button) => button.getAttribute('aria-current') === 'page');
      assert.equal(active.length, 1);
      assert.equal(panel.querySelectorAll('.settings-subpane').filter((pane) => !pane.hidden).length, 1);
      return active[0].getAttribute('data-subtab');
    };
    const visibleId = () => {
      const visible = panels.filter((panel) => !panel.hidden);
      assert.equal(visible.length, 1);
      const selected = buttons.filter((button) => button.getAttribute('aria-current') === 'page');
      assert.equal(selected.length, 1);
      assert.equal(selected[0].textContent, visible[0].querySelector('.settings-section-title').textContent);
      return visible[0].getAttribute('data-settings-section');
    };
    const panelIds = panels.map((panel) => panel.getAttribute('data-settings-section'));
    assert.equal(panels.length, GROUPS.reduce((sum, [, ids]) => sum + ids.length, 0));
    assert.equal(new Set(panelIds).size, panels.length);
    assert.deepEqual(panelIds, GROUPS.flatMap(([, ids]) => ids));
    assert.equal(visibleId(), 'model');
    // 双向渠道：三个子页面，点标签切换，永远只有一张可见
    const channelPanel = panels.find((panel) => panel.getAttribute('data-settings-section') === 'channels');
    const subtabButtons = subtabsOf(channelPanel);
    assert.deepEqual(subtabButtons.map((button) => button.getAttribute('data-subtab')), CHANNEL_SUBTABS);
    assert.equal(channelPanel.querySelectorAll('.settings-subpane').length, CHANNEL_SUBTABS.length);
    // 回复建议：生成设置 + 我的人设与表达风格两个子页面
    const replyPanel = panels.find((panel) => panel.getAttribute('data-settings-section') === 'reply-suggestions');
    assert.deepEqual(subtabsOf(replyPanel).map((button) => button.getAttribute('data-subtab')), ['generation', 'persona']);
    assert.equal(activeSubtab(replyPanel), 'generation');
    const personaPane = replyPanel.querySelectorAll('.settings-subpane').find((pane) => pane.getAttribute('data-subpane') === 'persona');
    assert.ok(personaPane.querySelector('textarea'), '人设输入框应该在「我的人设与表达风格」子页面里');
    // 联系人：聊天总结与画像更新是「联系人」板块下的子页面
    const contactsPanel = panels.find((panel) => panel.getAttribute('data-settings-section') === 'contacts');
    assert.deepEqual(subtabsOf(contactsPanel).map((button) => button.getAttribute('data-subtab')), ['profile-update']);
    assert.equal(activeSubtab(contactsPanel), 'profile-update');
    // 记忆输入：子页面「微信聊天记录」里放本人昵称 + 剪贴板自动识别导入；双向渠道的微信子页只管登录
    const capturePanel = panels.find((panel) => panel.getAttribute('data-settings-section') === 'capture');
    const hasNickname = (node) => node.querySelectorAll('input').some((input) => input.getAttribute('placeholder') === '多个昵称用逗号分隔');
    assert.deepEqual(subtabsOf(capturePanel).map((button) => button.getAttribute('data-subtab')), ['wechat-chat']);
    assert.equal(activeSubtab(capturePanel), 'wechat-chat');
    assert.equal(hasNickname(capturePanel), true);
    assert.equal(hasNickname(channelPanel), false);
    for (const [index, id] of CHANNEL_SUBTABS.entries()) {
      subtabButtons[index].dispatchEvent(new Event('click'));
      assert.equal(activeSubtab(channelPanel), id);
    }
    const modelInput = panels[0].querySelector('input');
    modelInput.value = 'unsaved-model-url';
    for (const button of buttons) {
      content.scrollTop = 300;
      button.onclick();
      const panel = panels.find(panel => panel.querySelector('.settings-section-title').textContent === button.textContent);
      assert.equal(visibleId(), panel.getAttribute('data-settings-section'));
      assert.equal(content.scrollTop, 0);
    }
    buttons[0].onclick();
    assert.equal(modelInput.value, 'unsaved-model-url');
    // 外部入口沿用子页面 id：落到「板块 + 子页」，其它 id 照旧
    for (const [section, expectedPanel, expectedTab, tabPanel] of [
      ['email', 'channels', 'email', channelPanel],
      ['wechat', 'channels', 'wechat', channelPanel],
      ['persona', 'reply-suggestions', 'persona', replyPanel],
      ['web-search', 'web-search', null, null]
    ]) {
      storage.set('settings-section', section);
      view.show();
      assert.equal(visibleId(), expectedPanel);
      if (expectedTab) assert.equal(activeSubtab(tabPanel), expectedTab);
      assert.equal(storage.has('settings-section'), false);
      await new Promise(setImmediate);
    }
    // 旧的「聊天总结与画像更新」链接落到联系人板块
    view.show({ section: 'profile-update' });
    assert.equal(visibleId(), 'contacts');
    await new Promise(setImmediate);
    view.show({ section: 'reply-suggestions' });
    assert.equal(visibleId(), 'reply-suggestions');
    await new Promise(setImmediate);
    root.dispatchEvent(new CustomEvent('dsh-settings-sections', { detail: [{ id: 'general', label: '通用设置' }, { id: 'models', label: '模型' }, { id: 'super-injector-plugins', label: '扩展管理' }] }));
    const agentPanel = root.querySelector('.settings-agent-panel');
    const agentNav = root.querySelector('.settings-agent-nav');
    assert.equal(agentNav.children.length, 1);
    agentNav.children[0].dispatchEvent(new Event('click'));
    assert.equal(agentPanel.hidden, false);
    assert.equal(panels.every(panel => panel.hidden), true);
    assert.equal(buttons.every(button => button.getAttribute('aria-current') === null), true);
    assert.equal(agentNav.children[0].getAttribute('aria-current'), 'page');
    view.show({ section: 'agent:models' });
    assert.equal(agentNav.children[0].getAttribute('aria-current'), null);
    assert.equal(visibleId(), 'model');
    // 分组导航：5 组，每组的按钮顺序与 GROUPS 声明一致，且每个板块都能从导航到达
    const navGroups = root.querySelectorAll('.settings-nav-group');
    assert.equal(navGroups.length, GROUPS.length);
    const navIds = [];
    GROUPS.forEach(([label, ids], index) => {
      const group = navGroups[index];
      assert.equal(group.querySelector('.settings-nav-group-label').textContent, label);
      const groupButtons = group.querySelectorAll('.settings-modal-nav-item');
      assert.deepEqual(groupButtons.map((button) => button.textContent), ids.map((id) => panels.find((panel) => panel.getAttribute('data-settings-section') === id).querySelector('.settings-section-title').textContent));
      navIds.push(...ids);
    });
    assert.deepEqual(navIds, panelIds);
    assert.equal(panels[0].querySelector('details').children.length, 3);
    buttons[0].onclick();
    assert.equal(agentPanel.hidden, true);
    assert.equal(visibleId(), 'model');
  } finally {
    view?.hide();
    Object.assign(global, previous);
  }
});

// 「推送重要邮件通知」只归「双向渠道 → 邮件」管：保存通知子页不能顺手改写它，
// 保存邮件子页要同时写 email.importantPush 与 notify.events.emailImportant（核心两个键都读）。
test('重要邮件通知只由邮件子页面写入', async () => {
  const previous = { document: global.document, fetch: global.fetch, sessionStorage: global.sessionStorage };
  const posts = [];
  global.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text })
  };
  global.sessionStorage = { getItem: () => null, removeItem: () => {} };
  global.fetch = async (url, init = {}) => {
    if (init.method === 'POST') posts.push(JSON.parse(init.body || '{}'));
    return new Response(JSON.stringify({}));
  };
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
  let view;
  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/settings.mjs')).href);
    const root = new Element('div');
    view = mount(root);
    const buttonByText = (text) => root.querySelectorAll('button').find((button) => button.textContent === text);

    buttonByText('保存通知设置').dispatchEvent(new Event('click'));
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].email, undefined, '保存通知设置不应改写邮件配置');
    assert.equal(posts[0].notify.events.emailImportant, undefined, '通知子页不再管重要邮件开关');

    posts.length = 0;
    buttonByText('保存邮件设置').dispatchEvent(new Event('click'));
    await flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].email.importantPush, false);
    assert.equal(posts[0].notify.events.emailImportant, false);
  } finally {
    view?.hide();
    Object.assign(global, previous);
  }
});
