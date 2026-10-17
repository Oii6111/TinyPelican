'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dshWeb = require('../core/agent/dsh-web-client');
const mainSession = require('../core/agent/main-session');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('同一微信会话的连续消息插入当前 DSH turn，只返回一次最终结果', async () => {
  const originalPrompt = dshWeb.promptAndWait;
  const originalSteer = dshWeb.sessionPrompt;
  const calls = [];
  const finished = deferred();
  let accepted;
  dshWeb.promptAndWait = async (options) => {
    calls.push({ type: 'prompt', options });
    options.onPromptAccepted();
    accepted = true;
    await finished.promise;
    return { ok: true, text: '合并后的回复' };
  };
  dshWeb.sessionPrompt = async (options) => {
    calls.push({ type: 'steer', options });
    return { ok: true, value: { accepted: true } };
  };
  try {
    const first = mainSession.send({ sessionKey: 'agent:main:weixin:peer', message: '[图片] photo.png', attachments: [{ kind: 'image', name: 'photo.png' }] });
    const second = mainSession.steer({ sessionKey: 'agent:main:weixin:peer', message: '重点看图片右侧的人物' });
    assert.equal(accepted, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(accepted, true);
    const steering = await second;
    assert.equal(steering.ok, true);
    assert.equal(calls.filter((call) => call.type === 'prompt').length, 1);
    assert.equal(calls.filter((call) => call.type === 'steer').length, 1);
    finished.resolve();
    assert.deepEqual(await first, { ok: true, text: '合并后的回复' });
  } finally {
    dshWeb.promptAndWait = originalPrompt;
    dshWeb.sessionPrompt = originalSteer;
  }
});

test('没有附件的连续文字消息同样插入当前 DSH turn', async () => {
  const originalPrompt = dshWeb.promptAndWait;
  const originalSteer = dshWeb.sessionPrompt;
  const finished = deferred();
  const calls = [];
  dshWeb.promptAndWait = async (options) => {
    calls.push({ type: 'prompt', options });
    options.onPromptAccepted();
    await finished.promise;
    return { ok: true, text: '文字消息合并回复' };
  };
  dshWeb.sessionPrompt = async (options) => {
    calls.push({ type: 'steer', options });
    return { ok: true, value: { accepted: true } };
  };
  try {
    const first = mainSession.send({ sessionKey: 'agent:main:weixin:text-peer', message: '我刚想到一个问题' });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await mainSession.steer({ sessionKey: 'agent:main:weixin:text-peer', message: '补充一下刚才的重点' });
    assert.equal(second.ok, true);
    assert.equal(calls.filter((call) => call.type === 'prompt').length, 1);
    assert.equal(calls.filter((call) => call.type === 'steer').length, 1);
    finished.resolve();
    assert.deepEqual(await first, { ok: true, text: '文字消息合并回复' });
  } finally {
    dshWeb.promptAndWait = originalPrompt;
    dshWeb.sessionPrompt = originalSteer;
  }
});

test('生成期间收到文件消息时，文件附件随 steer 一起提交', async () => {
  const originalPrompt = dshWeb.promptAndWait;
  const originalSteer = dshWeb.sessionPrompt;
  const finished = deferred();
  let steerOptions;
  dshWeb.promptAndWait = async (options) => {
    options.onPromptAccepted();
    await finished.promise;
    return { ok: true, text: '文件补充后的回复' };
  };
  dshWeb.sessionPrompt = async (options) => {
    steerOptions = options;
    return { ok: true, value: { accepted: true } };
  };
  try {
    const first = mainSession.send({ sessionKey: 'agent:main:weixin:file-peer', message: '先处理这件事' });
    await new Promise((resolve) => setImmediate(resolve));
    const attachment = { kind: 'file', name: '补充资料.pdf', path: 'C:/temp/补充资料.pdf', mimeType: 'application/pdf' };
    const result = await mainSession.steer({ sessionKey: 'agent:main:weixin:file-peer', message: '文件里是补充说明', attachments: [attachment] });
    assert.equal(result.ok, true);
    assert.equal(steerOptions.mode, 'steer');
    assert.deepEqual(steerOptions.attachments, [attachment]);
    finished.resolve();
    assert.deepEqual(await first, { ok: true, text: '文件补充后的回复' });
  } finally {
    dshWeb.promptAndWait = originalPrompt;
    dshWeb.sessionPrompt = originalSteer;
  }
});
