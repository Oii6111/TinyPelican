'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

class Element {
  constructor(tag) {
    this.tag = tag;
    this.nodeType = 1;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.classList = { add() {} };
    this.value = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; if (key === 'value') this.value = value; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  all() { return [this, ...this.children.filter(child => child instanceof Element).flatMap(child => child.all())]; }
}

const settle = async () => { for (let pass = 0; pass < 8; pass++) await new Promise(setImmediate); };

test('creating the first relationship opens the dashboard and subsequent visits keep it', async () => {
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  let primary = null;
  const routes = [];
  const relationship = { id: 'relationship-1', contactName: '小林', stage: '了解中', messageCount: 8, lastMessageAt: '2026-11-06 20:53' };
  global.document = { createElement: tag => new Element(tag), createTextNode: text => ({ nodeType: 3, textContent: text }) };
  global.setTimeout = () => 1;
  global.clearTimeout = () => {};
  global.fetch = async (url, options = {}) => {
    let result;
    if (url === '/api/romance/home') result = { primary, relationships: primary ? [primary] : [], schedules: [] };
    else if (url === '/api/settings') result = { selfNicknames: ['我'], capture: { enabled: true } };
    else if (url === '/api/contacts') result = [{ name: '小林', messages: 8 }];
    else if (url === '/api/romance/relationships' && options.method === 'POST') result = { relationship };
    else if (url === '/api/romance/relationships') result = { relationships: [] };
    else if (url === '/api/romance/relationships/relationship-1/primary') { primary = relationship; result = { ok: true }; }
    else throw new Error(`Unexpected endpoint: ${url}`);
    return new Response(JSON.stringify(result));
  };
  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/romance-home.mjs')).href);
    const root = new Element('section');
    const instance = mount(root, { navigate: (...args) => routes.push(args) });
    const findText = text => root.all().find(element => element.textContent === text);
    instance.show();
    await settle();
    await findText('创建这段关系').listeners.click();
    assert.ok(findText('今天，想聊点什么？'));
    assert.equal(root.all().some(element => element.tag === 'ol'), false);
    assert.ok(findText('8'));
    for (const [title, type] of [['帮我想想怎么回复', 'reply'], ['理解彼此的感受', 'analysis'], ['复盘最近的聊天', 'review']]) {
      const button = root.all().find(element => element.tag === 'button' && element.all().includes(findText(title)));
      button.listeners.click();
      assert.deepEqual(routes.at(-1), ['romance-coach', { relationshipId: relationship.id, type }]);
    }
    findText('去安排一次见面').listeners.click();
    assert.deepEqual(routes.at(-1), ['schedule-dashboard']);
    findText('管理关系').listeners.click();
    assert.deepEqual(routes.at(-1), ['romance-relationships']);
    findText('导入与添加关系').listeners.click();
    assert.ok(findText('第一步 · 导入微信聊天'));
    findText('返回当前关系').listeners.click();
    assert.ok(findText('今天，想聊点什么？'));
    instance.hide();
    instance.show();
    await settle();
    assert.ok(findText('今天，想聊点什么？'));
    assert.equal(root.all().some(element => element.tag === 'ol'), false);
    instance.hide();
  } finally { Object.assign(global, previous); }
});

test('romance home defaults to automatic capture, persists nickname and advances when captured messages appear', async () => {
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  let callback;
  let contacts = [];
  let saved;
  let unavailable = false;
  let settings = { selfNicknames: [], capture: { enabled: false } };
  global.document = { createElement: tag => new Element(tag), createTextNode: text => ({ nodeType: 3, textContent: text }) };
  global.setTimeout = handler => { callback = handler; return 1; };
  global.clearTimeout = () => { callback = null; };
  global.fetch = async (url, options = {}) => {
    let result;
    if (url === '/api/romance/home') result = { primary: null };
    else if (url === '/api/contacts') {
      if (unavailable) throw new Error('Core restarting');
      result = contacts;
    }
    else if (url === '/api/settings' && options.method === 'POST') {
      saved = JSON.parse(options.body);
      settings = saved;
      result = { ...saved, restarting: true };
    } else if (url === '/api/settings') result = settings;
    else throw new Error(`Unexpected endpoint: ${url}`);
    return new Response(JSON.stringify(result));
  };
  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/romance-home.mjs')).href);
    const root = new Element('section');
    const instance = mount(root, { navigate() {} });
    instance.show();
    await settle();
    assert.equal(root.all().some(element => element.tag === 'textarea'), false);
    assert.equal(root.all().some(element => element.attributes.type === 'file'), false);
    const findText = text => root.all().find(element => element.textContent === text);
    assert.ok(findText('保存昵称，开启自动导入'));
    const nickname = root.all().find(element => element.attributes.id === 'romance-self-nickname');
    nickname.listeners.input({ target: { value: '本人昵称' } });
    await findText('保存昵称，开启自动导入').listeners.click();
    assert.deepEqual(saved, { selfNicknames: ['本人昵称'], capture: { enabled: true } });
    assert.ok(callback);
    unavailable = true;
    await callback();
    assert.ok(root.all().some(element => element.textContent?.startsWith('暂时无法读取')));
    assert.ok(callback);
    unavailable = false;
    contacts = [{ name: '小明', lastMessageId: 8 }];
    await callback();
    assert.ok(findText('创建这段关系'));
    assert.equal(root.all().find(element => element.tag === 'option').attributes.value, '小明');
    assert.equal(callback, null);
    instance.hide();
    assert.equal(callback, null);
  } finally { Object.assign(global, previous); }
});

test('existing contact chat records are usable immediately without saving settings or copying again', async () => {
  const previous = { document: global.document, fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const requests = [];
  global.document = { createElement: tag => new Element(tag), createTextNode: text => ({ nodeType: 3, textContent: text }) };
  global.setTimeout = () => 1;
  global.clearTimeout = () => {};
  global.fetch = async (url, options = {}) => {
    requests.push([url, options.method]);
    const responses = {
      '/api/romance/home': { primary: null, relationships: [{ contactName: '已有关系' }] },
      '/api/settings': { selfNicknames: ['本人'], capture: { enabled: true } },
      '/api/contacts': [{ name: '已有关系', messages: 5 }, { name: '已入库对象', messages: 12 }, { name: '空联系人', messages: 0 }, { name: '本人', messages: 2 }]
    };
    return new Response(JSON.stringify(responses[url]));
  };
  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/romance-home.mjs')).href);
    const root = new Element('section');
    const instance = mount(root, { navigate() {} });
    instance.show();
    await settle();
    assert.deepEqual(root.all().filter(element => element.tag === 'option').map(element => element.attributes.value), ['已入库对象']);
    assert.ok(root.all().some(element => element.textContent === '创建这段关系'));
    assert.equal(requests.some(([, method]) => method === 'POST'), false);
    instance.hide();
  } finally { Object.assign(global, previous); }
});
