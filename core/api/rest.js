// 小鹈鹕核心 — HTTP 服务装配（静态资源 + 路由注册）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRouter } = require('./router');

const ROOT = path.resolve(__dirname, '..', '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const LOGO = path.join(ROOT, 'logo2.png');
const PORT = parseInt(process.env.V3_PORT || '18791', 10);
const VERSION = '0.4.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

// 只允许访问 dashboard 目录内的静态文件（防目录穿越）
async function serveStatic(res, relPath) {
  const abs = path.normalize(path.join(DASHBOARD, relPath));
  if (abs !== DASHBOARD && !abs.startsWith(DASHBOARD + path.sep)) return false;
  try {
    if (!fs.statSync(abs).isFile()) return false;
  } catch {
    return false;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  res.end(await fs.promises.readFile(abs));
  return true;
}

function createRestServer({ config = null, onRestart = null } = {}) {
  const router = createRouter();
  const ctx = { config, onRestart, json, readBody, version: VERSION };

  require('./routes/health')(router, ctx);
  require('./routes/status')(router, ctx);
  require('./routes/contacts')(router, ctx);
  require('./routes/search')(router, ctx);
  require('./routes/intents')(router, ctx);
  require('./routes/voice')(router, ctx);
  require('./routes/logs')(router, ctx);
  require('./routes/settings')(router, ctx);
  require('./routes/engine')(router, ctx);
  require('./routes/wechat')(router, ctx);
  require('./routes/chat')(router, ctx);
  require('./routes/agent')(router, ctx);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    try {
      const p = url.pathname;
      if (p === '/' || p === '/index.html') {
        const html = await fs.promises.readFile(path.join(DASHBOARD, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (p === '/logo.png') {
        const data = await fs.promises.readFile(LOGO);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(data);
      }
      if (p === '/favicon.ico' || p === '/styles.css' || p.startsWith('/src/')) {
        if (await serveStatic(res, p.slice(1))) return;
      }
      if (await router.match(req, res, ctx)) return;
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) });
    }
  });
}

module.exports = { createRestServer, VERSION };
