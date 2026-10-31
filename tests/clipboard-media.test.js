// 剪贴板带附件的聊天记录：多图配对 + 字节入库
// 关注点：微信私有格式的 item ↔ 消息一一对应、兜底按顺序配对、部分消息已入库时不错位、
// 重复复制不重复存字节、读取回来的元数据能直接给前端用。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-clip-media-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const chatDb = require('../core/memory/chat-db');
const { planAttachments, buildAttachments, readAttachment, messageKey, sniffImage } = require('../core/capture/clipboard-media');
const { parseSensorMedia } = require('../core/capture/clipboard');

// 真 PNG 头 + 一点填充就够：只验证魔数嗅探，不解码
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.from('JFIF\0', 'binary'), Buffer.alloc(64, 2)]);

function writeTmp(name, bytes) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function msg(name, ts, type, content = '') { return { name, ts, type, content }; }

test('多图：按微信私有格式的 item 位置配对，而不是按文件名', () => {
  const a = writeTmp('a.jpg', JPEG);
  const b = writeTmp('b.png', PNG);
  const msgs = [
    msg(':D', '2026-10-31 12:29', '图片'),
    msg(':D', '2026-10-31 12:30', 'text', '中间一句话'),
    msg(':D', '2026-10-31 12:31', '图片')
  ];
  const media = {
    files: [{ path: a, name: 'a.jpg' }, { path: b, name: 'b.png' }],
    wechat: [
      { file: a, text: ':D\n2026年10月31日 12:29\n[图片] 微信图片_1.dat' },
      { text: ':D\n2026年10月31日 12:30\n中间一句话' },
      { file: b, text: ':D\n2026年10月31日 12:31\n[图片] 微信图片_2.dat' }
    ]
  };
  const plan = planAttachments(msgs, media);
  assert.strictEqual(plan.length, 3);
  assert.strictEqual(plan[0].source, a);
  assert.strictEqual(plan[1], null, '文本消息不应该被挂附件');
  assert.strictEqual(plan[2].source, b);
  assert.deepStrictEqual(plan.map((entry) => entry && entry.kind), ['image', null, 'image']);
});

test('没有私有格式时按顺序把文件发给图片消息', () => {
  const a = writeTmp('c.jpg', JPEG);
  const b = writeTmp('d.jpg', JPEG);
  const msgs = [msg('x', '2026-10-31 10:00', 'text', '你好'), msg('x', '2026-10-31 10:01', '图片'), msg('x', '2026-10-31 10:02', '图片')];
  const plan = planAttachments(msgs, { files: [{ path: a }, { path: b }] });
  assert.strictEqual(plan[0], null);
  assert.strictEqual(plan[1].source, a);
  assert.strictEqual(plan[2].source, b);
});

test('文件数多于图片消息时，多余的忽略；少于时留空', () => {
  const a = writeTmp('e.jpg', JPEG);
  const b = writeTmp('f.jpg', JPEG);
  const one = [msg('x', 't', '图片')];
  assert.strictEqual(planAttachments(one, { files: [{ path: a }, { path: b }] })[0].source, a);
  const two = [msg('x', 't1', '图片'), msg('x', 't2', '图片')];
  const plan = planAttachments(two, { files: [{ path: a }] });
  assert.strictEqual(plan[1], null);
});

test('私有格式条目数与消息数不一致时退回顺序配对', () => {
  const a = writeTmp('g.jpg', JPEG);
  const msgs = [msg('x', 't1', '图片'), msg('x', 't2', '图片')];
  const media = { files: [{ path: a }], wechat: [{ text: '只有一条' }] };
  assert.strictEqual(planAttachments(msgs, media)[0].source, a);
});

test('readAttachment 按魔数判定图片类型，不信任扩展名', () => {
  const fake = writeTmp('looks-like.jpg.png', PNG);
  const record = readAttachment({ kind: 'image', source: fake, name: 'looks-like.jpg.png' });
  assert.strictEqual(record.kind, 'image');
  assert.strictEqual(record.mimeType, 'image/png');
  assert.strictEqual(record.size, PNG.length);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  const notImage = readAttachment({ kind: 'image', source: writeTmp('notes.txt', Buffer.from('hello')), name: 'notes.txt' });
  assert.strictEqual(notImage.kind, 'file', '内容不是图片时要降级成文件，不能当图片渲染');
});

test('sniffImage 认得 jpeg 与 png', () => {
  assert.strictEqual(sniffImage(JPEG).mimeType, 'image/jpeg');
  assert.strictEqual(sniffImage(PNG).mimeType, 'image/png');
  assert.strictEqual(sniffImage(Buffer.from('plain text')), null);
});

test('部分消息已入库时配对按整段算，新消息不会错位', () => {
  const a = writeTmp('h.jpg', JPEG);
  const b = writeTmp('i.jpg', JPEG);
  const all = [msg('x', 't1', 'text', '旧消息'), msg('x', 't2', '图片'), msg('x', 't3', '图片')];
  const media = {
    files: [{ path: a }, { path: b }],
    wechat: [{ text: 'x\n旧消息' }, { file: a, text: 'x\n图1' }, { file: b, text: 'x\n图2' }]
  };
  const fresh = [all[2]];                       // 只重放了最后一条
  const prepared = buildAttachments(fresh, all, media);
  assert.strictEqual(prepared.length, 1);
  assert.strictEqual(prepared[0].attachments[0].sha256, readAttachment({ kind: 'image', source: b }).sha256);
});

test('入库：附件落盘、库里存路径，读回来带 url 且重复导入不重复存', () => {
  const file = writeTmp('j.jpg', JPEG);
  const messages = [
    { name: '阿甲', ts: '2026-10-31 12:29', type: '图片', content: '', attachments: [readAttachment({ kind: 'image', source: file, name: 'j.jpg' })] },
    { name: '阿甲', ts: '2026-10-31 12:30', type: 'text', content: '今天加油！' }
  ];
  assert.strictEqual(chatDb.ingestMessages('阿甲', messages), 2);

  const ctx = chatDb.messages('阿甲', '', 50);
  const image = ctx.messages.find((entry) => entry.type === '图片');
  assert.ok(image, '图片消息应在库中');
  assert.strictEqual(image.attachments.length, 1);
  const attachment = image.attachments[0];
  assert.strictEqual(attachment.kind, 'image');
  assert.strictEqual(attachment.status, 'ready');
  assert.strictEqual(attachment.mimeType, 'image/jpeg');
  assert.strictEqual(attachment.url, `/api/contacts/attachment/${attachment.id}`);
  assert.match(attachment.downloadUrl, /\?download=1$/);

  const stored = chatDb.getAttachment(attachment.id);
  assert.ok(Buffer.from(stored.bytes).equals(JPEG), '读回来的字节要与源文件一致');
  assert.ok(stored.path.startsWith('media/chat/'), '库里存的应是相对路径');
  assert.ok(fs.existsSync(path.join(process.env.XIAOTIHU_DATA_DIR, ...stored.path.split('/'))), '文件应真的落在 media/chat 下');

  // 同一段再导入一次：消息去重，附件也不该重复
  assert.strictEqual(chatDb.ingestMessages('阿甲', messages), 0);
  const again = chatDb.messages('阿甲', '', 50).messages.find((entry) => entry.type === '图片');
  assert.strictEqual(again.attachments.length, 1);
});

test('删除消息后附件字节一并清理', () => {
  const file = writeTmp('k.jpg', JPEG);
  chatDb.ingestMessages('阿乙', [{ name: '阿乙', ts: '2026-10-31 09:00', type: '图片', content: '', attachments: [readAttachment({ kind: 'image', source: file })] }]);
  const before = chatDb.messages('阿乙', '', 10).messages[0].attachments[0];
  chatDb.clearMemberMessages('阿乙');
  assert.strictEqual(chatDb.getAttachment(before.id), null);
});

test('传感器 MEDIA 行能解成附件清单，坏数据当作没有附件', () => {
  const payload = { files: [{ path: 'C:/t/1.jpg', name: '1.jpg' }], wechat: [{ file: 'C:/t/1.jpg', text: 'x' }] };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const media = parseSensorMedia(encoded);
  assert.strictEqual(media.files.length, 1);
  assert.strictEqual(media.files[0].path, 'C:/t/1.jpg');
  assert.strictEqual(media.wechat[0].file, 'C:/t/1.jpg');
  assert.strictEqual(parseSensorMedia('not-base64-json'), null);
  assert.strictEqual(parseSensorMedia(Buffer.from('{"files":[],"wechat":[]}').toString('base64')), null);
});

test('消息 key 与 capturer 去重口径一致', () => {
  assert.strictEqual(messageKey({ name: 'a', ts: 't', type: 'text', content: 'c' }), 'a|t|text|c');
});
