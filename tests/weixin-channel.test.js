'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tinypelican-weixin-channel-'));
process.env.XIAOTIHU_DATA_DIR = temporary;

const { WeChatChannel, extractText } = require('../core/channels/weixin/channel');
const { getContext, setContext } = require('../core/channels/weixin/context');

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('all text and voice transcripts survive mixed message extraction', () => {
  assert.equal(extractText({ item_list: [
    { type: 1, text_item: { text: 'first paragraph' } },
    { type: 2, image_item: {} },
    { type: 1, text_item: { text: 'second paragraph' } },
    { type: 3, voice_item: { text: 'voice transcript' } }
  ] }), 'first paragraph\nsecond paragraph\nvoice transcript');
});

test('image-only message downloads its attachment and saves reply context first', async () => {
  const received = [];
  const image = { id: 'picture', kind: 'image', name: 'picture.png', path: path.join(temporary, 'picture.png'), mimeType: 'image/png', size: 3 };
  const channel = new WeChatChannel({
    downloadMedia: async (item) => {
      assert.equal(item.type, 2);
      assert.equal(getContext('account', 'image-sender'), 'image-context');
      return image;
    },
    onMessage: (message) => received.push(message)
  });
  channel.client = { accountId: 'account' };

  await channel._handleIncoming({ from_user_id: 'image-sender', context_token: 'image-context', item_list: [{ type: 2, image_item: {} }] });

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'image');
  assert.equal(received[0].contextToken, 'image-context');
  assert.match(received[0].content, /picture\.png/);
  assert.deepEqual(received[0].attachments, [image]);
});

test('failed file download preserves the message and does not discard other attachments', async () => {
  const received = [];
  const channel = new WeChatChannel({
    downloadMedia: async (item) => {
      if (item.type === 4) throw new Error('network failed');
      return { id: 'success', kind: 'image', name: 'photo.png', path: path.join(temporary, 'photo.png') };
    },
    onMessage: (message) => received.push(message)
  });
  channel.client = { accountId: 'account' };

  await channel._handleIncoming({ from_user_id: 'mixed-sender', item_list: [
    { type: 1, text_item: { text: 'please read these' } },
    { type: 4, file_item: { file_name: 'report.pdf' } },
    { type: 2, image_item: {} }
  ] });

  assert.equal(received[0].content, 'please read these');
  assert.equal(received[0].type, 'mixed');
  assert.equal(received[0].attachments.length, 2);
  assert.equal(received[0].attachments[0].name, 'report.pdf');
  assert.equal(received[0].attachments[0].status, 'failed');
  assert.equal(received[0].attachments[1].id, 'success');
});

test('polling continues with the next message after one callback rejects', async () => {
  const seen = [];
  let complete;
  const completion = new Promise((resolve) => { complete = resolve; });
  const channel = new WeChatChannel({ onMessage: async (message) => {
    seen.push(message.content);
    if (message.content === 'failure') throw new Error('handler failed');
    channel.running = false;
    complete();
  } });
  channel.client = {
    accountId: 'account',
    getUpdates: async () => ({ ok: true, msgs: ['failure', 'success'].map((text) => ({
      from_user_id: 'poll-sender', item_list: [{ type: 1, text_item: { text } }]
    })) })
  };
  channel.running = true;
  channel._poll();
  await completion;
  await new Promise((resolve) => setImmediate(resolve));
  clearTimeout(channel._pollTimer);
  assert.deepEqual(seen, ['failure', 'success']);
});

test('media send uses the active context and preserves a newer context on stale failure', async () => {
  setContext('account', 'outbound-peer', 'old-context');
  const attachment = { id: 'outbound', kind: 'file', name: 'report.pdf' };
  const channel = new WeChatChannel();
  channel.client = {
    accountId: 'account',
    sendMedia: async (to, record, context, options) => {
      assert.equal(to, 'outbound-peer');
      assert.equal(record, attachment);
      assert.equal(context, 'old-context');
      assert.equal(options.text, 'report');
      setContext('account', to, 'new-context');
      return { ok: false, staleToken: true };
    }
  };

  const result = await channel.send({ to: 'outbound-peer', text: 'report', attachment });
  assert.equal(result.ok, false);
  assert.equal(getContext('account', 'outbound-peer'), 'new-context');
});

test('an unfinished reply callback does not block the next update poll', { timeout: 3000 }, async (context) => {
  const seen = [];
  let releaseReply;
  let receivedNext;
  let polls = 0;
  let firstReplyFinished = false;
  const pendingReply = new Promise((resolve) => { releaseReply = resolve; });
  const nextReceived = new Promise((resolve) => { receivedNext = resolve; });
  const channel = new WeChatChannel({ onMessage: async (message) => {
    seen.push(message.content);
    if (message.content === 'first') {
      await pendingReply;
      firstReplyFinished = true;
      return;
    }
    assert.equal(firstReplyFinished, false);
    channel.running = false;
    receivedNext();
  } });
  channel.client = {
    accountId: 'account',
    getUpdates: async () => {
      polls += 1;
      return { ok: true, msgs: [{ from_user_id: 'async-peer', item_list: [{
        type: 1, text_item: { text: polls === 1 ? 'first' : 'second' }
      }] }] };
    }
  };
  context.after(() => {
    channel.running = false;
    clearTimeout(channel._pollTimer);
    releaseReply();
  });
  channel.running = true;
  channel._poll();

  await nextReceived;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(polls, 2);
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(firstReplyFinished, false);
});
