'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class Element {
  constructor(tag) {
    this.tagName = tag; this.nodeType = 1; this.children = []; this.listeners = {}; this.attributes = {};
    this.className = ''; this.textContent = ''; this.value = ''; this.open = false;
    this.classList = { toggle: (name, enabled) => { this.className = enabled ? this.className + ' ' + name : this.className.split(' ').filter((entry) => entry !== name).join(' '); } };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'value') this.value = value; if (name === 'open') this.open = true; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async click() { if (this.disabled) return; if (this.onclick) await this.onclick(); for (const callback of this.listeners.click || []) await callback({}); }
  all() { return [this, ...this.children.filter((entry) => entry instanceof Element).flatMap((entry) => entry.all())]; }
}

test('联系人画像可折叠、参考模板隐藏、操作集中，清空编辑区按完整替换保存', async () => {
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const root = new Element('div');
  let contact = { name: '联系人', remark: '', profile: { 基础身份: { 职业: '学生', 城市: '上海' }, 行为意向: { 爱好: '电影' }, 社交目的及策略: { 社交目的: '保持联系' } }, profileMeta: { updatedAt: '2026-09-26T01:01:59+08:00', source: 'full_history_analysis', confidence: 0.92 } };
  const calls = [];
  let resolveAnalysis;
  global.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => ({ nodeType: 3, textContent: text }), getElementById: () => null, body: new Element('body') };
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body });
    if (url === '/api/contacts') return new Response(JSON.stringify([contact]));
    if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [] }));
    if (url.endsWith('/chat-summary')) return new Response(JSON.stringify({ chatSummary: { summary: '双方交流工作与生活。', topics: ['2026-09-14｜工作近况：双方交流实习近况。'] }, jobs: [] }));
    if (url.endsWith('/analyze-profile')) {
      await new Promise((resolve) => { resolveAnalysis = resolve; });
      return new Response(JSON.stringify({ ok: true, queued: true }));
    }
    if (url.endsWith('/profile') && body) { contact = { ...contact, profile: body.profile }; return new Response(JSON.stringify({ ok: true, profile: contact.profile })); }
    return new Response(JSON.stringify(contact));
  };
  const settle = async () => { for (let pass = 0; pass < 10; pass++) await new Promise(setImmediate); };
  const button = (text) => root.all().find((entry) => entry.tagName === 'button' && entry.textContent === text);
  let view;
  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/contacts.mjs')).href);
    view = mount(root);
    await settle();
    await root.all().find((entry) => entry.className.includes('wechat-contact-item')).click();
    await settle();
    await button('👤 画像').click();
    await settle();
    const details = root.all().filter((entry) => entry.tagName === 'details');
    const fields = details.find((entry) => entry.children[0].textContent === '具体画像');
    assert.ok(fields);
    assert.equal(fields.open, false);
    const children = fields.children.find((entry) => entry.className === 'wechat-profile-children');
    assert.ok(children.children.some((entry) => entry.tagName === 'details' && entry.children[0].textContent === '基础身份'));
    assert.equal(fields.all().some((entry) => entry.className.includes('wechat-profile-meta')), false);
    const pane = root.all().find((entry) => entry.className.includes('wechat-profile-pane'));
    const footer = pane.children.at(-1);
    assert.equal(footer.tagName, 'footer');
    assert.match(footer.textContent, /来源：完整历史分析 · 置信度：92%/);
    const summary = details.find((entry) => entry.children[0].textContent === '聊天话题总结');
    assert.ok(summary);
    assert.equal(summary.open, false);
    assert.equal(summary.all().some((entry) => entry.tagName === 'button'), false);
    assert.ok(!root.all().some((entry) => entry.textContent.includes('参考字段与了解方向')));
    assert.ok(!calls.some((entry) => entry.url.endsWith('/profile') || entry.url.includes('profile-template')));
    const actions = root.all().find((entry) => entry.className === 'wechat-profile-actions');
    assert.deepEqual(actions.children.filter((entry) => entry.tagName === 'button').map((entry) => entry.textContent), ['保存画像', '立即生成 / 重建总结', '分析完整历史生成画像', '清空聊天记录', '删除联系人']);
    const analyze = button('分析完整历史生成画像');
    const generating = analyze.click();
    assert.equal(analyze.disabled, true);
    assert.equal(analyze.textContent, '画像生成中…');
    resolveAnalysis();
    await generating;
    await settle();
    for (const editor of root.all().filter((entry) => entry.tagName === 'textarea' && entry.className.includes('wechat-profile-editor'))) editor.value = '';
    await button('保存画像').click();
    await settle();
    const saved = calls.find((entry) => entry.url.endsWith('/profile') && entry.body);
    assert.equal(saved.body.profileMode, 'replace');
    assert.ok(Object.values(saved.body.profile).every((section) => Object.keys(section).length === 0));
    assert.ok(root.all().filter((entry) => entry.tagName === 'textarea' && entry.className.includes('wechat-profile-editor')).every((entry) => !/学生|上海|电影|保持联系/.test(entry.value)));
  } finally { view?.hide(); Object.assign(global, previous); }
});
