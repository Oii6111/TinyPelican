import { createServer } from 'node:http';
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)); // v3/dashboard
const V3 = dirname(ROOT); // v3
const DATA_DIR = process.env.XIAOTIHU_DATA_DIR;
const CONTACTS = DATA_DIR ? join(DATA_DIR, 'contacts') : join(V3, 'contacts');
const CONFIG = DATA_DIR ? join(DATA_DIR, 'config.json') : join(V3, 'config.json');
const VOICE_PENDING = DATA_DIR ? join(DATA_DIR, 'voice-pending.json') : join(V3, 'voice-pending.json');
const INTENTS = DATA_DIR ? join(DATA_DIR, 'intents.json') : join(V3, 'intents.json');
const ACTIVITY_LOG = DATA_DIR ? join(DATA_DIR, 'activity.log') : join(V3, 'activity.log');
const PORT = parseInt(process.env.V3_PORT || '18791', 10);
const CHAT_SESSION = 'agent:main:main';
const OPENCLAW_ENTRY = join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
const SESSIONS_DIR = join(process.env.USERPROFILE || '', '.openclaw', 'agents', 'main', 'sessions');

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

async function listContacts() {
  if (!existsSync(CONTACTS)) return [];
  const files = (await readdir(CONTACTS)).filter((f) => f.endsWith('.json')).sort();
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(await readFile(join(CONTACTS, f), 'utf8'));
      out.push({
        name: c.name || f.replace(/\.json$/, ''),
        remark: c.remark || '',
        messages: Array.isArray(c.messages) ? c.messages.length : 0,
        updatedAt: c.updatedAt || '',
        important: !!c.important
      });
    } catch {}
  }
  return out;
}

async function readVoicePending() {
  if (!existsSync(VOICE_PENDING)) return [];
  try {
    const data = JSON.parse(await readFile(VOICE_PENDING, 'utf8'));
    return Array.isArray(data) ? data : data ? [data] : [];
  } catch {
    return [];
  }
}

async function writeVoicePending(items) {
  await writeFile(VOICE_PENDING, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

async function readIntents() {
  if (!existsSync(INTENTS)) return [];
  try {
    const data = JSON.parse(await readFile(INTENTS, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function writeIntents(items) {
  await writeFile(INTENTS, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

async function readLogs(limit = 200) {
  if (!existsSync(ACTIVITY_LOG)) return [];
  try {
    const raw = await readFile(ACTIVITY_LOG, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-limit);
    const out = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

async function readHistory(sessionKey) {
  const idxPath = join(SESSIONS_DIR, 'sessions.json');
  if (!existsSync(idxPath)) return [];
  let idx = {};
  try { idx = JSON.parse(await readFile(idxPath, 'utf8')); } catch { return []; }
  const entry = idx[sessionKey];
  const file = entry && entry.sessionFile;
  if (!file || !existsSync(file)) return [];
  const raw = await readFile(file, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || !line.includes('"type":"message"')) continue;
    try {
      const rec = JSON.parse(line);
      const msg = rec.message;
      if (!msg) continue;
      if (msg.role === 'user' && typeof msg.content === 'string') {
        if (msg.content.includes('[OpenClaw heartbeat poll]')) continue;
        out.push({ role: 'user', text: msg.content });
      } else if (msg.role === 'assistant') {
        const text = extractAssistantText(msg.content);
        if (text && text.trim().toUpperCase() === 'HEARTBEAT_OK') continue;
        if (text) out.push({ role: 'bot', text });
      }
    } catch {}
  }
  return out;
}

async function summarizeSession(file) {
  const raw = await readFile(file, 'utf8');
  let title = '';
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('"type":"message"')) continue;
    try {
      const rec = JSON.parse(line);
      const msg = rec.message;
      if (!msg) continue;
      if (msg.role === 'user' && typeof msg.content === 'string') {
        if (msg.content.includes('[OpenClaw heartbeat poll]')) continue;
        if (!title) title = msg.content.replace(/\s+/g, ' ').slice(0, 40);
        count++;
      } else if (msg.role === 'assistant') {
        count++;
      }
    } catch {}
  }
  return { title: title || '新对话', count };
}

async function listConversations() {
  const idxPath = join(SESSIONS_DIR, 'sessions.json');
  if (!existsSync(idxPath)) return [];
  let idx = {};
  try { idx = JSON.parse(await readFile(idxPath, 'utf8')); } catch { return []; }
  const convs = [];
  for (const [key, entry] of Object.entries(idx)) {
    if (!key.startsWith('agent:main:')) continue;
    if (/subagent|v3-|speed|nettest|remarktest|verify|recover|ingest/.test(key)) continue;
    const file = entry && entry.sessionFile;
    if (!file || !existsSync(file)) continue;
    try {
      const { title, count } = await summarizeSession(file);
      convs.push({ key, title, count, updatedAt: entry.updatedAt || '' });
    } catch {}
  }
  convs.sort((a, b) => (String(b.updatedAt) < String(a.updatedAt) ? -1 : String(b.updatedAt) > String(a.updatedAt) ? 1 : 0));
  return convs;
}

async function deleteConversation(key) {
  const idxPath = join(SESSIONS_DIR, 'sessions.json');
  if (!existsSync(idxPath)) return false;
  let idx = {};
  try { idx = JSON.parse(await readFile(idxPath, 'utf8')); } catch { return false; }
  const entry = idx[key];
  if (!entry || !entry.sessionFile) return false;
  const base = entry.sessionFile.replace(/\.jsonl$/, '');
  for (const p of [entry.sessionFile, base + '.trajectory.jsonl', base + '.trajectory-path.json']) {
    try { if (existsSync(p)) await unlink(p); } catch {}
  }
  delete idx[key];
  await writeFile(idxPath + '.bak', JSON.stringify(idx, null, 2), 'utf8');
  await writeFile(idxPath, JSON.stringify(idx, null, 2), 'utf8');
  return true;
}

function runAgent(message, sessionKey) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [OPENCLAW_ENTRY, 'agent', '--session-key', sessionKey, '--message', message, '--thinking', 'off', '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = '';
      try {
        const p = JSON.parse(stdout);
        text = (p?.result?.payloads || []).map((x) => x.text).filter(Boolean).join('\n');
      } catch {
        text = stdout.trim();
      }
      if (code !== 0) resolve({ ok: false, error: stderr.trim() || ('exit ' + code), reply: text });
      else resolve({ ok: true, reply: text });
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(ROOT, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (url.pathname === '/logo.png') {
      const data = await readFile(join(V3, 'logo2.png'));
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(data);
    }
    if (url.pathname === '/favicon.ico') {
      const data = await readFile(join(ROOT, 'favicon.ico'));
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      return res.end(data);
    }
    if (url.pathname === '/api/contacts') {
      return json(res, 200, await listContacts());
    }
    const cm = url.pathname.match(/^\/api\/contacts\/(.+)$/);
    if (cm && !cm[1].endsWith('/important')) {
      const fp = join(CONTACTS, decodeURIComponent(cm[1]) + '.json');
      if (!existsSync(fp)) return json(res, 404, { error: 'not found' });
      return json(res, 200, JSON.parse(await readFile(fp, 'utf8')));
    }
    const im = url.pathname.match(/^\/api\/contacts\/(.+)\/important$/);
    if (im && req.method === 'POST') {
      const fp = join(CONTACTS, decodeURIComponent(im[1]) + '.json');
      if (!existsSync(fp)) return json(res, 404, { error: 'not found' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const doc = JSON.parse(await readFile(fp, 'utf8'));
      doc.important = !!body.important;
      await writeFile(fp, JSON.stringify(doc, null, 2), 'utf8');
      return json(res, 200, { ok: true, important: doc.important });
    }
    if (url.pathname === '/api/history') {
      const session = url.searchParams.get('session') || CHAT_SESSION;
      return json(res, 200, await readHistory(session));
    }
    if (url.pathname === '/api/conversations') {
      if (req.method === 'POST') {
        return json(res, 200, { key: 'agent:main:webui:' + Date.now() });
      }
      if (req.method === 'DELETE') {
        const key = url.searchParams.get('session') || '';
        const ok = await deleteConversation(key);
        return json(res, ok ? 200 : 404, { ok });
      }
      return json(res, 200, await listConversations());
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const message = String(body.message || '').trim();
      const session = String(body.session || CHAT_SESSION).trim();
      if (!message) return json(res, 400, { error: 'empty message' });
      const r = await runAgent(message, session);
      return json(res, r.ok ? 200 : 500, r);
    }
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') {
        return json(res, 200, JSON.parse(await readFile(CONFIG, 'utf8')));
      }
      if (req.method === 'POST') {
        const patch = JSON.parse((await readBody(req)) || '{}');
        const cur = JSON.parse(await readFile(CONFIG, 'utf8'));
        const next = { ...cur, ...patch };
        await writeFile(CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
        return json(res, 200, next);
      }
    }
    if (url.pathname === '/api/logs') {
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      return json(res, 200, await readLogs(Math.min(Math.max(limit, 1), 500)));
    }
    if (url.pathname === '/api/intents') {
      const items = await readIntents();
      const status = url.searchParams.get('status');
      if (status) return json(res, 200, items.filter((x) => x.status === status));
      return json(res, 200, items);
    }
    const im2 = url.pathname.match(/^\/api\/intents\/(.+)$/);
    if (im2 && req.method === 'POST') {
      const id = decodeURIComponent(im2[1]);
      const body = JSON.parse((await readBody(req)) || '{}');
      const items = await readIntents();
      const target = items.find((x) => x.id === id);
      if (!target) return json(res, 404, { error: 'not found' });
      if (body.status) target.status = body.status;
      if (body.summary) target.summary = String(body.summary);
      if (body.dueAt !== undefined) target.dueAt = body.dueAt;
      if (body.dueText !== undefined) target.dueText = String(body.dueText);
      target.updatedAt = new Date().toISOString();
      await writeIntents(items);
      return json(res, 200, { ok: true, intent: target });
    }
    if (url.pathname === '/api/voice-pending') {
      if (req.method === 'DELETE') {
        const idx = parseInt(url.searchParams.get('index') || '0', 10);
        const items = await readVoicePending();
        if (idx >= 0 && idx < items.length) {
          items.splice(idx, 1);
          await writeVoicePending(items);
          return json(res, 200, { ok: true });
        }
        return json(res, 400, { error: 'bad index' });
      }
      return json(res, 200, await readVoicePending());
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`小鹈鹕用户端: http://127.0.0.1:${PORT}`);
});
