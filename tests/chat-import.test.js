// 微信聊天记录批量导入：ZIP/TXT/CSV/JSON → SQLite
// 关注点：格式识别、按联系人归档、重复导入去重、危险压缩包防护、无法识别时如实报告。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-import-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const chatDb = require('../core/memory/chat-db');
const { importChatArchives, parseAny, contactFromName } = require('../core/import/chat-archive');
const { parseWechatForwardExport } = require('../core/import/chat-archive');
const { readEntries } = require('../core/import/zip');

const CFG = { selfNicknames: ['六壹'] };

// ── 手工构造 ZIP（不引第三方依赖，顺带验证读取器）───────────────────────────
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.content, 'utf8');
    const method = entry.store ? 0 : 8;
    const data = method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags || 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.claimSize !== undefined ? entry.claimSize : raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(entry.flags || 0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(entry.claimSize !== undefined ? entry.claimSize : raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

const CLIP_TEXT = [
  '张三',
  '2026年9月10日 10:00',
  '方案我看了，整体可以',
  '',
  '六壹',
  '2026年9月10日 10:05',
  '那我周五前发终稿',
  '',
  '张三',
  '2026年9月10日 10:06',
  '好，辛苦了'
].join('\n');

function write(name, content) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, content);
  return file;
}

test('TXT（微信复制格式）：按联系人归档进 SQLite', async () => {
  const file = write('与张三的聊天记录.txt', CLIP_TEXT);
  const summary = await importChatArchives({ paths: [file], config: CFG });
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.messages, 3);
  assert.strictEqual(summary.added, 3);
  assert.deepStrictEqual(Object.keys(summary.contacts), ['张三']);
  assert.strictEqual(chatDb.contactContext('张三', { limit: 10 }).recentMessages.length, 3);
});

test('重复导入同一文件：不产生重复消息', async () => {
  const file = write('与张三的聊天记录2.txt', CLIP_TEXT);
  const summary = await importChatArchives({ paths: [file], config: CFG });
  assert.strictEqual(summary.added, 0, '内容重复应全部被去重');
  assert.strictEqual(chatDb.contactContext('张三', { limit: 10 }).recentMessages.length, 3);
});

test('ZIP：多条目、多个联系人一次导入', async () => {
  const zip = makeZip([
    { name: '与李四的聊天记录.txt', content: ['李四', '2026年9月11日 09:00', '周末一起吃饭？', '', '六壹', '2026年9月11日 09:02', '好啊'].join('\n') },
    { name: '与王五的聊天记录.txt', content: ['王五', '2026年9月12日 20:00', '资料收到了吗'].join('\n') },
    { name: 'readme.png', content: 'x', store: true }
  ]);
  const file = path.join(tmp, '微信聊天记录导出.zip');
  fs.writeFileSync(file, zip);
  const summary = await importChatArchives({ paths: [file], config: CFG });
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.added, 3);
  assert.deepStrictEqual(Object.keys(summary.contacts).sort(), ['李四', '王五']);
  assert.strictEqual(chatDb.contactContext('李四', { limit: 10 }).recentMessages.length, 2);
  assert.strictEqual(chatDb.contactContext('王五', { limit: 10 }).recentMessages.length, 1);
  // 非文本条目被忽略，但文件整体仍算导入成功
  assert.strictEqual(summary.files.filter((f) => f.status === 'imported').length, 2);
});

test('CSV / JSON 导出格式也能识别', () => {
  const csv = 'name,ts,type,content\n张三,2026-09-10 10:00,text,在吗\n六壹,2026-09-10 10:01,text,在的\n';
  const parsedCsv = parseAny(csv, 'x.csv');
  assert.strictEqual(parsedCsv.format, 'csv');
  assert.deepStrictEqual(parsedCsv.messages.map((m) => m.content), ['在吗', '在的']);

  const json = JSON.stringify([{ sender: '张三', timestamp: '2026-09-10 10:00', content: '在吗' }]);
  const parsedJson = parseAny(json, 'x.json');
  assert.strictEqual(parsedJson.format, 'json');
  assert.strictEqual(parsedJson.messages[0].name, '张三');
  assert.strictEqual(parsedJson.messages[0].ts, '2026-09-10 10:00');
});

test('宽松行格式（带方括号时间戳）也能识别', () => {
  const text = '[2026-09-10 10:00] 张三: 在吗\n[2026-09-10 10:01] 六壹: 在的\n';
  const parsed = parseAny(text, 'x.txt');
  assert.strictEqual(parsed.format, 'lines');
  assert.strictEqual(parsed.messages.length, 2);
});

test('联系人名可从文件名推断（与X的聊天记录.txt）', () => {
  assert.strictEqual(contactFromName('与张三的聊天记录.txt', ['六壹']), '张三');
  assert.strictEqual(contactFromName('张三.txt', []), '张三');
  assert.strictEqual(contactFromName('六壹.txt', ['六壹']), '', '自己的名字不该被当成联系人');
  assert.strictEqual(contactFromName('chat_李四_20260910.txt', []), '李四');
});

test('危险压缩包：拒绝路径穿越与加密条目', () => {
  const evil = makeZip([{ name: '../../evil.txt', content: 'x' }]);
  const entries = readEntries(evil);
  assert.deepStrictEqual(entries, [], '含 .. 的条目应被忽略');

  const encrypted = makeZip([{ name: 'a.txt', content: 'x', flags: 0x1 }]);
  assert.throws(() => readEntries(encrypted), /加密/);
});

test('压缩炸弹防护：声明体积超限直接拒绝', () => {
  const bomb = makeZip([{ name: 'bomb.txt', content: 'x'.repeat(1024), claimSize: 200 * 1024 * 1024 }]);
  assert.throws(() => readEntries(bomb), /过大/);
});

test('无法识别的内容如实报告（preview 便于补格式）', async () => {
  const file = write('unknown.txt', '这是一段没有任何时间戳的文本\n第二行\n');
  const summary = await importChatArchives({ paths: [file], config: CFG });
  assert.strictEqual(summary.added, 0);
  assert.strictEqual(summary.files[0].status, 'unparsed');
  assert.ok(summary.files[0].preview.includes('没有任何时间戳'));
});

test('不存在的路径与不支持的类型：报错但不中断其它文件', async () => {
  const good = write('与赵六的聊天记录.txt', ['赵六', '2026年9月13日 08:00', '早'].join('\n'));
  const bad = write('photo.png', 'not an image');
  const summary = await importChatArchives({ paths: [bad, good, path.join(tmp, '没有这个文件.txt')], config: CFG });
  assert.strictEqual(summary.added, 1);
  const statuses = summary.files.map((f) => f.status);
  assert.ok(statuses.includes('unsupported'));
  assert.ok(statuses.includes('error'));
  assert.ok(statuses.includes('imported'));
});

test('dry-run：只解析不入库', async () => {
  const file = write('与钱七的聊天记录.txt', ['钱七', '2026年9月14日 08:00', '试运行'].join('\n'));
  const summary = await importChatArchives({ paths: [file], config: CFG, dryRun: true });
  assert.strictEqual(summary.dryRun, true);
  assert.strictEqual(summary.messages, 1);
  assert.strictEqual(summary.added, 0);
  assert.strictEqual(chatDb.contactContext('钱七', { limit: 5 }), null, 'dry-run 不该建联系人');
});

// ── 微信 4.x「转发到其他应用」导出（真实格式）────────────────────────────────
const FORWARD_TXT = [
  '·[文件] 丁宸辉-个人简历.pdf',
  '',
  '·[图片] 微信图片_202609141659_1.jpg',
  '',
  '·[链接] OPC 狂喜，这个 GitHub 把白嫖玩到了极致。 https://mp.weixin.qq.com/s?__biz=abc',
  '',
  '·明天下午给我一个你的一日工作汇报',
  '·二期方案什么时候能给我看看',
  '·我这边还在收尾，今天整理完给您',
  '',
  '·[语音] 1"'
].join('\n');

test('转发导出格式：一行一条、中点前缀、媒体占位都能识别', () => {
  const messages = parseWechatForwardExport(FORWARD_TXT);
  assert.strictEqual(messages.length, 7);
  assert.deepStrictEqual(messages.map((m) => m.type), ['文件', '图片', '链接', 'text', 'text', 'text', '语音']);
  assert.strictEqual(messages[0].content, '丁宸辉-个人简历.pdf');
  assert.strictEqual(messages[2].content.startsWith('OPC 狂喜'), true);
  assert.strictEqual(messages[3].content, '明天下午给我一个你的一日工作汇报');
  const parsed = parseAny(FORWARD_TXT, '聊天记录.txt');
  assert.strictEqual(parsed.format, 'wechat-forward');
});

test('转发导出 ZIP：归档到「未归属」容器、媒体类型保留、重复导入去重、附件登记', async () => {
  const zip = makeZip([
    { name: '聊天记录.txt', content: FORWARD_TXT },
    { name: '聊天记录内的图片、视频和文件/丁宸辉-个人简历.pdf', content: '%PDF-1.4 fake', store: true },
    { name: '聊天记录内的图片、视频和文件/微信图片_202609141659_1.jpg', content: 'fakejpg', store: true }
  ]);
  const file = path.join(tmp, '聊天记录_20260916_233405.zip');
  fs.writeFileSync(file, zip);

  const first = await importChatArchives({ paths: [file], config: CFG });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.added, 7);
  assert.deepStrictEqual(Object.keys(first.contacts), ['微信导出（未归属）']);
  assert.strictEqual(first.attachments.length, 2, '包内附件应被登记（不落盘）');
  const ctx = chatDb.contactContext('微信导出（未归属）', { limit: 20 });
  assert.strictEqual(ctx.recentMessages.length, 7);
  assert.strictEqual(ctx.recentMessages[0].ts, '2026-09-16 23:34', '无时间戳的消息用导出时间归档');
  const types = new Set(ctx.recentMessages.map((m) => m.type));
  assert.ok(types.has('文件') && types.has('图片') && types.has('链接') && types.has('语音') && types.has('text'));

  const again = await importChatArchives({ paths: [file], config: CFG });
  assert.strictEqual(again.added, 0, '同一份导出重复导入应全部去重');
});

test('导入时可用 contact 覆盖归属（分享流程里由用户指定）', async () => {
  const file = path.join(tmp, '聊天记录_20260916_233405.zip');   // 复用上一个用例写下的文件
  const summary = await importChatArchives({ paths: [file], config: CFG, contact: '丁宸辉' });
  assert.deepStrictEqual(Object.keys(summary.contacts), ['丁宸辉']);
  assert.strictEqual(chatDb.contactContext('丁宸辉', { limit: 10 }).recentMessages.length, 7);
});
