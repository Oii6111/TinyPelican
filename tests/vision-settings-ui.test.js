// 设置页「图片描述用的视觉模型」：字段存在、回填正确、保存时随模型设置一起提交
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

class Element {
  constructor(tag) {
    this.tagName = tag; this.nodeType = 1; this.children = []; this.attributes = {}; this.listeners = {};
    this.className = ''; this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
    this.style = {}; this.textContent = '';
    this.classList = { toggle: () => {}, add: () => {}, remove: () => {} };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
    if (['checked', 'disabled', 'hidden', 'open'].includes(name)) this[name] = true;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatchEvent(event) {
    if (event.type === 'click' && typeof this.onclick === 'function') this.onclick(event);
    for (const callback of this.listeners[event.type] || []) callback(event);
    return true;
  }
  all() { return [this, ...this.children.filter((c) => c instanceof Element).flatMap((c) => c.all())]; }
  querySelectorAll(selector) {
    return this.all().slice(1).filter((entry) => selector.startsWith('.')
      ? entry.className.split(' ').includes(selector.slice(1))
      : entry.tagName === selector);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

test('设置页可以单独指定视觉模型，并随模型设置一起保存', async () => {
  const previous = { document: global.document, fetch: global.fetch, sessionStorage: global.sessionStorage };
  const storage = new Map();
  global.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    getElementById: () => null,
    body: new Element('body')
  };
  global.sessionStorage = { getItem: (k) => storage.get(k) || null, removeItem: (k) => storage.delete(k) };

  const saved = [];
  const settings = {
    engine: {
      provider: 'deepseek',
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-****abcd', model: 'deepseek-chat' },
        openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-****efgh', model: 'gpt-4o-mini' }
      },
      vision: { provider: 'openai', model: 'gpt-4o-mini' }
    }
  };
  global.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/api/engine/vision')) {
      return new Response(JSON.stringify({
        ok: true, provider: 'deepseek', model: 'deepseek-chat',
        configured: { provider: 'openai', model: 'gpt-4o-mini' },
        vision: { provider: 'openai', model: 'gpt-4o-mini', explicit: true }
      }));
    }
    if (target.includes('/api/engine/test')) return new Response(JSON.stringify({ ok: true, model: 'x', latencyMs: 1 }));
    if (String(init.method || 'GET').toUpperCase() === 'POST') {
      saved.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ...settings, restarting: false }));
    }
    return new Response(JSON.stringify(settings));
  };

  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/settings.mjs')).href);
    const root = new Element('div');
    const view = mount(root);
    view.show({ section: 'model' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);

    const modelPanel = root.querySelectorAll('.settings-section').find((panel) => panel.getAttribute('data-settings-section') === 'model');
    assert.ok(modelPanel, '模型服务板块应存在');

    const selects = modelPanel.querySelectorAll('select');
    const visionSelect = selects.find((select) => select.children.some((option) => option.textContent === '跟随当前模型'));
    assert.ok(visionSelect, '应该有「图片描述用的视觉模型」下拉');
    assert.deepStrictEqual(
      visionSelect.children.map((option) => option.value),
      ['', 'siliconflow', 'openai', 'deepseek', 'ollama', 'custom'],
      '选项应是「跟随当前模型」+ 全部服务商'
    );
    assert.strictEqual(visionSelect.value, 'openai', '应从配置回填已选的视觉服务商');

    const inputs = modelPanel.querySelectorAll('input');
    const visionModel = inputs.find((input) => input.value === 'gpt-4o-mini');
    assert.ok(visionModel, '视觉模型名应从配置回填');

    const status = modelPanel.querySelectorAll('p').find((node) => /现在用/.test(node.textContent || ''));
    assert.ok(status, '应显示当前实际使用哪个模型生成图片描述');
    assert.match(status.textContent, /openai \/ gpt-4o-mini/);

    const saveButton = modelPanel.querySelectorAll('button').find((button) => button.textContent === '保存模型设置');
    assert.ok(saveButton, '模型设置保存按钮应存在');
    await saveButton.onclick();
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);

    assert.ok(saved.length, '保存应发出请求');
    assert.deepStrictEqual(saved[saved.length - 1].engine.vision, { provider: 'openai', model: 'gpt-4o-mini' });
  } finally {
    Object.assign(global, previous);
  }
});
