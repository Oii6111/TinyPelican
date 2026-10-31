// 附件描述：首次导入生成一次，之后 agent 回读不用再识图
// 关注点：视觉模型怎么选、不支持视觉时退化成什么、描述落库后长什么样、落盘位置正确。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-describe-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const chatDb = require('../core/memory/chat-db');
const store = require('../core/memory/attachment-store');
const { describeAttachment, metadataDescription, visionTarget, isVisionModel } = require('../core/memory/attachment-describe');
const { ingestCapturedBatch } = require('../core/ingest/pipeline');

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR', 'ascii'),
  Buffer.from([0, 0, 3, 1]),   // width 769
  Buffer.from([0, 0, 1, 64]),  // height 320
  Buffer.alloc(32, 0)
]);

function cfgWith(model, extra = {}) {
  return {
    engine: {
      provider: 'custom',
      providers: { custom: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test-key', model } },
      ...extra
    },
    selfNicknames: []
  };
}

test('模型名判定：视觉模型认得出来，纯文本模型不认', () => {
  assert.strictEqual(isVisionModel('gpt-4o-mini'), true);
  assert.strictEqual(isVisionModel('qwen2.5-vl-7b-instruct'), true);
  assert.strictEqual(isVisionModel('deepseek-flash'), true);
  assert.strictEqual(isVisionModel('deepseek-chat'), false);
  assert.strictEqual(isVisionModel('kimi-k2.6'), false);
});

test('当前模型不支持视觉时，如实提示并说明怎么配', () => {
  const target = visionTarget(cfgWith('deepseek-chat'));
  assert.strictEqual(target.ok, false);
  assert.strictEqual(target.reason, 'unsupported');
  assert.match(target.error, /不支持视觉/);
  assert.match(target.error, /engine\.vision/);
});

test('显式配置视觉模型优先于当前模型', () => {
  const cfg = cfgWith('deepseek-chat', { vision: { provider: 'custom', model: 'qwen2.5-vl-7b' } });
  const target = visionTarget(cfg);
  assert.strictEqual(target.ok, true);
  assert.strictEqual(target.model, 'qwen2.5-vl-7b');
  assert.strictEqual(target.explicit, true);
});

test('服务商显式声明 supportsVision 时按声明走', () => {
  const cfg = cfgWith('some-private-model');
  cfg.engine.providers.custom.supportsVision = true;
  assert.strictEqual(visionTarget(cfg).ok, true);
  cfg.engine.providers.custom.supportsVision = false;
  const off = visionTarget(cfg);
  assert.strictEqual(off.ok, false);
  assert.match(off.error, /不支持视觉/);
});

test('元数据描述带类型、文件名、格式、大小和尺寸', () => {
  const text = metadataDescription({ kind: 'image', name: 'a.png', mimeType: 'image/png', size: 45222, width: 769, height: 320 });
  assert.match(text, /图片「a\.png」/);
  assert.match(text, /image\/png/);
  assert.match(text, /769×320/);
  const doc = metadataDescription({ kind: 'file', name: '通知书.pdf', mimeType: 'application/pdf', size: 147397, pages: 3 });
  assert.match(doc, /文件「通知书\.pdf」/);
  assert.match(doc, /3 页/);
});

test('图片拿不到视觉模型时，描述退化成元数据并记下原因', async () => {
  const result = await describeAttachment({ kind: 'image', name: 'a.png', mimeType: 'image/png', size: PNG.length, bytes: PNG, width: 769, height: 320 }, cfgWith('deepseek-chat'));
  assert.strictEqual(result.descriptionSource, 'metadata');
  assert.strictEqual(result.visionUnsupported, true);
  assert.match(result.description, /769×320/);
  assert.ok(result.descriptionError, '要留下失败原因，方便排查');
});

test('文件类附件永远走元数据描述，不发模型请求', async () => {
  const cfg = cfgWith('gpt-4o-mini');
  let called = false;
  const originalFetch = global.fetch;
  global.fetch = async () => { called = true; throw new Error('不应该请求'); };
  try {
    const result = await describeAttachment({ kind: 'file', name: '报告.pdf', mimeType: 'application/pdf', size: 1024, pages: 2 }, cfg);
    assert.strictEqual(result.descriptionSource, 'metadata');
    assert.strictEqual(called, false);
  } finally { global.fetch = originalFetch; }
});

test('落盘：同内容只存一份，路径按 sha256 命名', () => {
  const rel = store.save(PNG, { sha256: 'a'.repeat(64), name: 'x.png', mimeType: 'image/png' });
  assert.strictEqual(rel, `media/chat/${'a'.repeat(64)}.png`);
  assert.ok(fs.existsSync(store.absolutePath(rel)));
  const again = store.save(PNG, { sha256: 'a'.repeat(64), name: 'x.png', mimeType: 'image/png' });
  assert.strictEqual(again, rel, '重复写入应复用同一份');
});

test('同一份附件已经在这段聊天里时，不重复落盘也不重复描述', async () => {
  const imgPath = path.join(tmp, 'dup.png');
  fs.writeFileSync(imgPath, PNG);
  const msgs = [{ name: '重复人', ts: '2026-10-31 10:00', type: '图片', content: '' }];
  const media = { files: [{ path: imgPath, name: 'dup.png' }], wechat: [{ file: imgPath, text: '重复人\n[图片] dup.dat' }] };

  const first = await ingestCapturedBatch(msgs, '重复人', { media, allMsgs: msgs, config: cfgWith('deepseek-chat') });
  assert.strictEqual(first.added, 1);
  assert.strictEqual(first.saved, 1);

  const ctx = chatDb.messages('重复人', '', 10);
  const attachment = ctx.messages[0].attachments[0];
  assert.strictEqual(chatDb.attachmentExists('重复人', ''), false, '空 sha256 不能当成命中');
  assert.strictEqual(chatDb.attachmentExists('重复人', chatDb.getAttachment(attachment.id).sha256), true);
  assert.ok(chatDb.descriptionForSha(chatDb.getAttachment(attachment.id).sha256).description, '描述可以被别的消息复用');

  const second = await ingestCapturedBatch(msgs, '重复人', { media, allMsgs: msgs, config: cfgWith('deepseek-chat') });
  assert.strictEqual(second.added, 0, '消息本身去重');
  assert.strictEqual(second.saved, 0, '附件不该重复落盘');
  assert.strictEqual(second.described, 0, '不该再花一次识图');
});

test('删消息时把附件文件一起清掉，不留孤儿文件', () => {
  const file = path.join(tmp, 'orphan.png');
  fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from('orphan')]));
  chatDb.ingestMessages('孤儿测试', [{
    name: '孤儿测试', ts: '2026-10-31 09:00', type: '图片', content: '',
    attachments: [{
      kind: 'image', name: 'orphan.png', mimeType: 'image/png', size: fs.statSync(file).size,
      sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      description: '元数据描述', descriptionSource: 'metadata', bytes: fs.readFileSync(file)
    }]
  }]);
  const record = chatDb.getAttachment(chatDb.messages('孤儿测试', '', 5).messages[0].attachments[0].id);
  assert.ok(fs.existsSync(store.absolutePath(record.path)));

  chatDb.clearMemberMessages('孤儿测试');
  assert.strictEqual(chatDb.getAttachment(record.id), null);
  assert.strictEqual(fs.existsSync(store.absolutePath(record.path)), false, '没人引用的文件要删掉');
});

test('整条链路：配对 → 落盘 → 元数据描述 → 入库，agent 回读直接拿到描述', async () => {
  // 用不同的字节，避免命中前面用例留下的同图描述缓存
  const unique = Buffer.concat([PNG, Buffer.from('chain-1')]);
  const imgPath = path.join(tmp, 'src.png');
  fs.writeFileSync(imgPath, unique);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('/Type /Pages /Count 2\n'), Buffer.from('/Type /Page\n/Type /Page\n')]);
  const pdfPath = path.join(tmp, 'src.pdf');
  fs.writeFileSync(pdfPath, pdf);

  const msgs = [
    { name: '高翔', ts: '2026-10-30 21:52', type: '图片', content: '' },
    { name: '高翔', ts: '2026-10-30 21:52', type: '文件', content: '' }
  ];
  const media = {
    files: [{ path: imgPath, name: 'src.png' }, { path: pdfPath, name: '国自然项目批准通知书.pdf' }],
    wechat: [
      { file: imgPath, text: '高翔\n[图片] 微信图片_1.dat' },
      { file: pdfPath, text: '高翔\n[文件] 国自然项目批准通知书.pdf' }
    ]
  };

  const result = await ingestCapturedBatch(msgs, '高翔', { media, allMsgs: msgs, config: cfgWith('deepseek-chat') });
  assert.strictEqual(result.added, 2);
  assert.strictEqual(result.visionUnsupported, true, '当前模型不支持视觉要上报，供上层提示用户');
  assert.strictEqual(result.saved, 2);

  const ctx = chatDb.messages('高翔', '', 20);
  const withFiles = ctx.messages.filter((message) => message.attachments && message.attachments.length);
  assert.strictEqual(withFiles.length, 2);

  const image = withFiles.find((message) => message.type === '图片').attachments[0];
  assert.strictEqual(image.kind, 'image');
  assert.strictEqual(image.descriptionSource, 'metadata');
  assert.strictEqual(image.name, '微信图片_1.png', '微信给的 .dat 占位名要换成真实扩展名');
  assert.match(image.description, /图片「微信图片_1\.png」/);
  assert.match(image.description, /769×320/);

  const doc = withFiles.find((message) => message.type === '文件').attachments[0];
  assert.strictEqual(doc.kind, 'file');
  assert.strictEqual(doc.name, '国自然项目批准通知书.pdf', '文件用微信文本里的真名，不用临时哈希名');
  assert.match(doc.description, /文件「国自然项目批准通知书\.pdf」/);
  assert.match(doc.description, /2 页/);

  // 磁盘上确实有这两个文件，且与源文件一致
  for (const attachment of [image, doc]) {
    const record = chatDb.getAttachment(attachment.id);
    assert.strictEqual(record.path, `media/chat/${record.sha256}${path.extname(record.name).toLowerCase()}`);
    assert.ok(fs.existsSync(store.absolutePath(record.path)));
  }
  assert.ok(chatDb.getAttachment(doc.id).bytes.equals(pdf));
});
