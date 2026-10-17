'use strict';

const http = require('http');
const https = require('https');
const { pipeline } = require('stream');
const dshWeb = require('../agent/dsh-web-client');
const webAuth = require('../agent/dsh-web-auth');
const { transformHtml, transformScript, EMBED_PREFIX } = require('../agent/dsh-embed');

function allowedRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  return req.headers.origin === 'http://' + req.headers.host || req.headers.origin === 'https://' + req.headers.host;
}

function upstreamOptions(req, base, cookie) {
  const target = new URL(base);
  const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' };
  delete headers.cookie;
  delete headers.authorization;
  delete headers.referer;
  if (cookie) headers.cookie = cookie;
  if (headers.origin) headers.origin = target.origin;
  return { target, options: {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: '/' + req.url.slice(EMBED_PREFIX.length),
    headers
  } };
}

function createDshProxy({ config, base = dshWeb.DEFAULT_BASE, getCookie = () => webAuth.ensureCookie({ base, config }) } = {}) {
  const sockets = new Set();

  async function handle(req, res) {
    if (!req.url.startsWith(EMBED_PREFIX)) return false;
    if (!allowedRequest(req)) {
      res.writeHead(403).end('Forbidden');
      return true;
    }
    try {
      const { target, options } = upstreamOptions(req, base, await getCookie());
      await new Promise((resolve) => {
        const upstream = (target.protocol === 'https:' ? https : http).request(options, (response) => {
          const headers = { ...response.headers, 'cache-control': 'no-store' };
          delete headers['set-cookie'];
          delete headers['content-length'];
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          if (headers.location) {
            const location = new URL(headers.location, target);
            if (location.origin !== target.origin) {
              response.resume();
              res.writeHead(502).end('Unexpected upstream redirect');
              resolve();
              return;
            }
            headers.location = EMBED_PREFIX.slice(0, -1) + location.pathname + location.search;
          }
          const type = String(headers['content-type'] || '');
          const pathname = new URL(options.path, target).pathname;
          const page = pathname === '/' || pathname === '/index.html';
          const script = pathname.startsWith('/plugins/') || pathname.startsWith('/assets/');
          const transform = response.statusCode === 200 && (page && /text\/html/.test(type) ? transformHtml : script && /(?:javascript|ecmascript)/.test(type) ? transformScript : null);
          if (!transform) {
            res.writeHead(response.statusCode, headers);
            pipeline(response, res, () => resolve());
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > 32 * 1024 * 1024) response.destroy(new Error('DSH resource too large'));
            else chunks.push(chunk);
          });
          response.on('error', () => {
            if (!res.headersSent) res.writeHead(502).end('DSH resource unavailable');
            resolve();
          });
          response.on('end', () => {
            try {
              const body = transform(Buffer.concat(chunks).toString('utf8'));
              res.writeHead(response.statusCode, headers).end(body);
            } catch (error) {
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(error.message);
            }
            resolve();
          });
        });
        upstream.setTimeout(120000, () => upstream.destroy(new Error('DSH request timeout')));
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502).end('DSH connection unavailable');
          else res.destroy();
          resolve();
        });
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
      });
    } catch {
      if (!res.headersSent) res.writeHead(503).end('DSH authentication unavailable');
    }
    return true;
  }

  async function upgrade(req, socket, head) {
    if (!req.url.startsWith(EMBED_PREFIX) || !allowedRequest(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    try {
      const { target, options } = upstreamOptions(req, base, await getCookie());
      const upstream = (target.protocol === 'https:' ? https : http).request(options);
      socket.on('error', () => upstream.destroy());
      upstream.on('upgrade', (response, remote, remoteHead) => {
        remote.setTimeout(0);
        sockets.add(socket);
        sockets.add(remote);
        const headers = Object.entries(response.headers).filter(([name]) => name !== 'set-cookie').map(([name, value]) => `${name}: ${value}`).join('\r\n');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        socket.pipe(remote).pipe(socket);
        socket.on('error', () => remote.destroy());
        remote.on('error', () => socket.destroy());
        socket.on('close', () => { sockets.delete(socket); remote.destroy(); });
        remote.on('close', () => { sockets.delete(remote); socket.destroy(); });
      });
      upstream.on('response', (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\n\r\n`); });
      upstream.on('error', () => socket.destroy());
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.end();
    } catch {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    }
  }

  return { handle, upgrade, close() { for (const socket of sockets) socket.destroy(); sockets.clear(); } };
}

module.exports = { createDshProxy };
