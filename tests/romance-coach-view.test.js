'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

class Element {
  constructor(tag) { this.tag = tag; this.nodeType = 1; this.children = []; this.attributes = {}; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  all() { return [this, ...this.children.filter(child => child instanceof Element).flatMap(child => child.all())]; }
}

test('coach supports suggestions, follow-ups, retries, persisted history and contact switching', async () => {
  const previous = { document: global.document, fetch: global.fetch };
  global.document = { createElement: tag => new Element(tag), createTextNode: text => ({ nodeType: 3, textContent: text }) };
  const records = { first: [], second: [] };
  const requests = [];
  let fail = false;
  global.fetch = async (url, options = {}) => {
    if (url === '/api/romance/relationships') return Response.json({ primaryId: 'first', relationships: [{ id: 'first', contactName: '甲' }, { id: 'second', contactName: '乙' }] });
    if (url === '/api/romance/coach/chat') {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (fail) return Response.json({ error: '模型服务尚未配置，请检查 API Key。' }, { status: 502 });
      records[body.relationshipId].push({ role: 'user', text: body.message }, { role: 'assistant', text: '可以试着温和地问问。' });
      return Response.json({ messages: records[body.relationshipId] });
    }
    const id = url.split('/').at(-1);
    return Response.json({ messages: records[id] });
  };
  try {
    const { mount } = await import(pathToFileURL(path.resolve(__dirname, '../dashboard/src/views/romance-coach.mjs')).href);
    const root = new Element('section');
    const view = mount(root, { navigate() {} });
    const byText = text => root.all().find(item => item.textContent === text);
    const input = () => root.all().find(item => item.tag === 'textarea');
    await view.show();
    assert.ok(byText('这句话怎么回？'));
    assert.equal(byText('开始这次教练'), undefined);
    await byText('这句话怎么回？').listeners.click();
    assert.equal(requests[0].relationshipId, 'first');
    input().listeners.input({ target: { value: '再简短一些' } });
    await byText('发送').listeners.click();
    assert.equal(requests[1].message, '再简短一些');
    fail = true;
    input().listeners.input({ target: { value: '换一种语气' } });
    await byText('发送').listeners.click();
    assert.ok(byText('重试回复'));
    assert.equal(input().textContent, '换一种语气');
    fail = false;
    await byText('重试回复').listeners.click();
    assert.equal(records.first.length, 6);
    view.hide();
    await view.show({ relationshipId: 'second' });
    assert.ok(byText('这句话怎么回？'));
    assert.equal(byText('换一种语气'), undefined);
    await view.show({ relationshipId: 'first' });
    assert.ok(byText('换一种语气'));
    const entry = { relationshipId: 'second', type: 'review' };
    await view.show(entry);
    assert.equal(requests.at(-1).relationshipId, 'second');
    assert.match(requests.at(-1).message, /复盘/);
    const count = requests.length;
    view.hide();
    await view.show(entry);
    assert.equal(requests.length, count, 'returning to the cached route must not send the shortcut again');
    view.hide();
  } finally { Object.assign(global, previous); }
});
