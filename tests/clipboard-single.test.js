// 剪贴板只复制「单条聊天消息」时的归档行为：
//  - 只有一个块（昵称/时间/内容）也必须识别，不能被「最少匹配行数」或单行兜底吞掉；
//  - 看着像聊天却没解析出消息的文本，不能被当成语音转写回填进待回填队列。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-capture-single-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const { ClipboardWatcher } = require('../core/capture/clipboard');
const voice = require('../core/memory/stores/voice');
const chatDb = require('../core/memory/chat-db');
const { ingestMessages } = require('../core/ingest/pipeline');

const WIN = {
  handle: '123',
  pid: '9',
  processName: 'WeChat',
  bounds: { left: 0, top: 0, right: 800, bottom: 600 },
  dpi: 96
};

const SINGLE = ['Hank', '2026年9月15日 21:30', '明天下午三点开会'].join('\n');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWatcher(batches, minMatchLines = 2) {
  return new ClipboardWatcher({
    onBatch: (b) => batches.push(b),
    config: { selfNicknames: ['我'], capture: { enabled: true }, pollMs: 700, minMatchLines }
  });
}

test('复制单条聊天消息也要归档（默认最少匹配行数 2 放行）', async () => {
  const batches = [];
  const watcher = makeWatcher(batches);
  watcher._handleClip(SINGLE, WIN);
  await sleep(400);
  watcher.stop();

  assert.strictEqual(batches.length, 1, '单条消息也要触发 onBatch');
  assert.strictEqual(batches[0].msgs.length, 1);
  assert.strictEqual(batches[0].contact, 'Hank');
  assert.strictEqual(batches[0].repeat, false);

  const added = ingestMessages(batches[0].msgs, batches[0].contact);
  assert.strictEqual(added, 1, '单条消息要能落到归档库，后续意图扫描才看得到');
  assert.strictEqual(chatDb.messages('Hank', '', 10).messages.length, 1);
});

test('单行格式的单条消息：门槛为 2 行时不归档，调成 1 行后归档', async () => {
  const lineOnly = 'Hank 2026年9月15日 21:30 明天下午三点开会';

  const strict = [];
  const strictWatcher = makeWatcher(strict, 2);
  strictWatcher._handleClip(lineOnly, WIN);
  await sleep(400);
  strictWatcher.stop();
  assert.strictEqual(strict.length, 0);

  const loose = [];
  const looseWatcher = makeWatcher(loose, 1);
  looseWatcher._handleClip(lineOnly, WIN);
  await sleep(400);
  looseWatcher.stop();
  assert.strictEqual(loose.length, 1);
  assert.strictEqual(loose[0].msgs.length, 1);
  assert.strictEqual(loose[0].contact, 'Hank');
});

test('看着像聊天但没解析出消息时，不会把文本当成语音转写回填', async () => {
  voice.save([]);
  voice.enqueue('罗卜头', { name: '罗卜头', ts: '2026-09-15 21:30', type: '语音', content: '' });

  const batches = [];
  const watcher = makeWatcher(batches);
  // 只有昵称 + 时间行、没有内容：解析不出消息，但明显是聊天文本
  watcher._handleClip(['Hank', '2026年9月15日 21:30'].join('\n'), WIN);
  await sleep(400);
  watcher.stop();

  const pending = voice.list();
  assert.strictEqual(pending.length, 1, '待回填语音不能被聊天文本吃掉');
  assert.strictEqual(pending[0].content, '');
  assert.strictEqual(batches.length, 0);

  // 真正的语音转写文本（不含聊天时间行）仍应正常回填
  const text = '明天我先问一下排期，再回复你';
  watcher._handleClip(text, WIN);
  await sleep(400);
  watcher.stop();
  const filled = voice.list();
  assert.strictEqual(filled.length, 0, '普通文本要继续走语音回填');
});
