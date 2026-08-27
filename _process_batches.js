// 小鹈鹕 V3 — 纯代码批次处理器（不经过任何 Agent / LLM）
// 读 batches/*.jsonl -> 按 contact 分组建档为 contacts/<昵称>.json -> 成功后删除批次
// 最后 stdout 只输出一个整数：本次真正新增的消息条数
const fs = require('fs');
const path = require('path');

const base = __dirname;
const dataDir = process.env.XIAOTIHU_DATA_DIR;
const batchesDir = dataDir ? path.join(dataDir, 'batches') : path.join(base, 'batches');
const contactsDir = dataDir ? path.join(dataDir, 'contacts') : path.join(base, 'contacts');

fs.mkdirSync(contactsDir, { recursive: true });

const EMPTY_PROFILE = {
  '关系类型': '未知',
  '近况': '',
  '偏好': '',
  '重要承诺/待办': '',
  '敏感话题/注意点': '',
  '情绪趋势': '',
  '最近互动时间': ''
};

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '').replace(/^[\s.]+|[\s.]+$/g, '') || 'contact';
}

const batchFiles = fs.readdirSync(batchesDir).filter((f) => f.endsWith('.jsonl')).sort();
let totalAdded = 0;

for (const file of batchFiles) {
  const fp = path.join(batchesDir, file);
  const lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const byContact = new Map();

  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const key = (m.contact && String(m.contact).trim()) ? String(m.contact).trim() : String(m.name || '');
    if (!key) continue;
    if (!byContact.has(key)) byContact.set(key, []);
    byContact.get(key).push(m);
  }

  for (const [contact, msgs] of byContact) {
    const jp = path.join(contactsDir, sanitize(contact) + '.json');
    let doc = { name: contact, remark: '', updatedAt: '', messages: [], profile: Object.assign({}, EMPTY_PROFILE) };
    if (fs.existsSync(jp)) {
      try { doc = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch {}
    }
    if (!Array.isArray(doc.messages)) doc.messages = [];
    if (!doc.profile || typeof doc.profile !== 'object') doc.profile = Object.assign({}, EMPTY_PROFILE);
    if (doc.remark === undefined || doc.remark === null) doc.remark = '';

    const seen = new Set(doc.messages.map((x) => `${x.name}|${x.ts}|${x.type}|${x.content}`));
    let added = 0;
    for (const m of msgs) {
      const key = `${m.name}|${m.ts}|${m.type}|${m.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      doc.messages.push({
        name: String(m.name || ''),
        ts: String(m.ts || ''),
        type: String(m.type || 'text'),
        content: String(m.content || '')
      });
      added++;
    }
    doc.messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    doc.updatedAt = new Date().toISOString();
    fs.writeFileSync(jp, JSON.stringify(doc, null, 2), 'utf8');
    totalAdded += added;
  }

  fs.unlinkSync(fp); // 已成功写入 contacts，删除批次文件
}

console.log(totalAdded);
