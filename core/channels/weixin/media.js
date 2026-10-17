'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const REQUEST_TIMEOUT_MS = 60000;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mediaDirectory(directory) {
  return path.resolve(directory || require('../../lib/paths').getPaths().weixinMedia);
}

function safeName(name, fallback) {
  const cleaned = String(name || fallback).replace(/\\/g, '/').split('/').pop()
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 180);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function imageFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: '.png', mimeType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) {
    return { extension: '.jpg', mimeType: 'image/jpeg' };
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return { extension: '.gif', mimeType: 'image/gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: '.webp', mimeType: 'image/webp' };
  }
  return null;
}

function safeMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase().trim();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
      || ['text/html', 'image/svg+xml', 'application/xhtml+xml'].includes(value)) {
    return 'application/octet-stream';
  }
  return value;
}

async function saveBuffer(buffer, { name, kind = 'auto', mimeType, direction = 'outbound', directory } = {}) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new Error('媒体内容必须是二进制数据');
  if (!buffer.byteLength) throw new Error('文件内容为空，请选择其他文件');
  if (buffer.byteLength > MAX_MEDIA_BYTES) throw new Error('文件超过 100 MB 限制');
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const image = kind !== 'file' ? imageFormat(bytes) : null;
  const id = crypto.randomUUID();
  const base = mediaDirectory(directory);
  const filename = id + (image ? image.extension : '.bin');
  const target = path.join(base, filename);
  const sidecar = path.join(base, id + '.json');
  const temporary = target + '.tmp';
  const record = {
    id,
    name: safeName(name, image ? `图片${image.extension}` : '文件'),
    kind: image ? 'image' : 'file',
    size: bytes.length,
    mimeType: image ? image.mimeType : safeMimeType(mimeType),
    path: target,
    direction: direction === 'inbound' ? 'inbound' : 'outbound',
    createdAt: new Date().toISOString()
  };
  await fs.mkdir(base, { recursive: true });
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.writeFile(sidecar, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return record;
  } catch (error) {
    await Promise.allSettled([fs.unlink(temporary), fs.unlink(target), fs.unlink(sidecar)]);
    throw error;
  }
}

async function getMedia(id, { directory } = {}) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  const base = mediaDirectory(directory);
  try {
    const sidecar = path.join(base, id + '.json');
    const sidecarStat = await fs.lstat(sidecar);
    if (!sidecarStat.isFile() || sidecarStat.size > 16384) return null;
    const stored = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    if (stored.id !== id || typeof stored.path !== 'string') return null;
    const filename = path.basename(stored.path);
    if (!['.png', '.jpg', '.gif', '.webp', '.bin'].some(extension => filename === id + extension)) return null;
    const target = path.join(base, filename);
    if (path.resolve(stored.path) !== target) return null;
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.size > MAX_MEDIA_BYTES || stat.size !== stored.size) return null;
    return {
      id,
      name: safeName(stored.name, '文件'),
      kind: stored.kind === 'image' && filename !== id + '.bin' ? 'image' : 'file',
      size: stat.size,
      mimeType: safeMimeType(stored.mimeType),
      path: target,
      direction: stored.direction === 'inbound' ? 'inbound' : 'outbound',
      createdAt: stored.createdAt
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function publicAttachment(record) {
  if (record && record.status === 'failed') {
    return {
      kind: record.kind === 'image' ? 'image' : 'file',
      name: safeName(record.name, record.kind === 'image' ? '图片' : '文件'),
      status: 'failed',
      error: String(record.error || '').includes('100 MB') ? '文件超过 100 MB 限制' : '媒体接收失败，请重试'
    };
  }
  if (!record || !ID_PATTERN.test(String(record.id || ''))) return null;
  return {
    id: record.id,
    name: safeName(record.name, '文件'),
    kind: record.kind === 'image' ? 'image' : 'file',
    size: record.size,
    mimeType: safeMimeType(record.mimeType),
    status: 'ready',
    url: '/api/wechat/media/' + record.id,
    downloadUrl: '/api/wechat/media/' + record.id + '?download=1'
  };
}

function checkedCdnUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('微信 CDN 地址无效'); }
  const hostname = url.hostname.toLowerCase();
  const official = ['weixin.qq.com', 'wechat.com'].some(domain => hostname === domain || hostname.endsWith('.' + domain));
  if (url.protocol !== 'https:' || !official || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('仅允许 HTTPS 微信官方 CDN 地址');
  }
  return url.toString();
}

function cdnUrl(base, endpoint, parameters) {
  const url = new URL(checkedCdnUrl(base));
  if (url.search || url.hash) throw new Error('微信 CDN 基础地址无效');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + endpoint;
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return checkedCdnUrl(url.toString());
}

function parseKey(value, hex = false) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('微信媒体缺少解密密钥');
  if (hex) {
    if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error('微信媒体解密密钥格式无效');
    return Buffer.from(value, 'hex');
  }
  if (!/^[a-z0-9+/]+={0,2}$/i.test(value)) throw new Error('微信媒体解密密钥格式无效');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw new Error('微信媒体解密密钥格式无效');
}

async function requestCdn(url, options, processResponse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(checkedCdnUrl(url), { ...options, redirect: 'error', signal: controller.signal });
    return await processResponse(response);
  } catch (error) {
    if (error.mediaError) throw error;
    const safeError = new Error(controller.signal.aborted ? '微信媒体传输超时，请重试' : '微信媒体传输失败，请重试');
    safeError.mediaError = true;
    throw safeError;
  } finally {
    clearTimeout(timer);
  }
}

function mediaError(message, status) {
  const error = new Error(message);
  error.mediaError = true;
  error.status = status;
  return error;
}

async function boundedResponse(response, limit) {
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > limit) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw mediaError('文件超过 100 MB 限制');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw mediaError('微信媒体响应没有可读取的内容');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw mediaError('文件超过 100 MB 限制');
      }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

async function uploadMedia(client, { record, to, cdnBaseUrl = DEFAULT_CDN_BASE_URL } = {}) {
  if (!client || typeof client.getUploadUrl !== 'function') throw new Error('微信客户端不支持媒体上传');
  if (!record || !record.path || !to) throw new Error('请选择文件和收件人');
  const stored = await getMedia(record.id, { directory: path.dirname(record.path) });
  if (!stored) throw new Error('文件不存在，请重新选择');
  const plaintext = await fs.readFile(stored.path);
  if (plaintext.length > MAX_MEDIA_BYTES) throw new Error('文件超过 100 MB 限制');
  const key = crypto.randomBytes(16);
  const filekey = crypto.randomBytes(16).toString('hex');
  const md5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const response = await client.getUploadUrl({
    filekey,
    media_type: stored.kind === 'image' ? 1 : 3,
    to_user_id: to,
    rawsize: plaintext.length,
    rawfilemd5: md5,
    filesize: encrypted.length,
    no_need_thumb: true,
    aeskey: key.toString('hex')
  });
  if (!response || !response.ok || !response.data
      || (response.data.ret != null && Number(response.data.ret) !== 0)
      || (response.data.errcode != null && Number(response.data.errcode) !== 0)) {
    throw new Error('微信媒体上传地址获取失败，请重新登录或重试');
  }
  const fullUrl = String(response.data.upload_full_url || '').trim();
  const uploadParam = response.data.upload_param;
  if (!fullUrl && !uploadParam) throw new Error('微信服务没有返回媒体上传地址');
  const url = fullUrl ? checkedCdnUrl(fullUrl) : cdnUrl(cdnBaseUrl, 'upload', { encrypted_query_param: uploadParam, filekey });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const encryptQueryParam = await requestCdn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encrypted
      }, async uploaded => {
        if (uploaded.status !== 200) {
          if (uploaded.body) await uploaded.body.cancel().catch(() => {});
          throw mediaError('微信 CDN 上传失败（HTTP ' + uploaded.status + '）', uploaded.status);
        }
        const parameter = uploaded.headers.get('x-encrypted-param');
        if (uploaded.body) await uploaded.body.cancel().catch(() => {});
        if (!parameter) throw mediaError('微信 CDN 没有返回媒体下载参数');
        return parameter;
      });
      return {
        encryptQueryParam,
        aesKey: Buffer.from(key.toString('hex'), 'ascii').toString('base64'),
        size: plaintext.length,
        ciphertextSize: encrypted.length,
        md5
      };
    } catch (error) {
      if ((error.status >= 400 && error.status < 500) || attempt === 2) throw error;
    }
  }
}

async function downloadItem(item, { directory, cdnBaseUrl = DEFAULT_CDN_BASE_URL } = {}) {
  const kind = item && Number(item.type) === 2 ? 'image' : 'file';
  if (!item || ![2, 4].includes(Number(item.type))) throw new Error('暂不支持此微信媒体类型');
  const payload = kind === 'image' ? item.image_item : item.file_item;
  const media = payload && payload.media;
  if (!media) throw new Error('微信消息缺少媒体信息');
  if (kind === 'file' && Number(payload.len) > MAX_MEDIA_BYTES) throw new Error('文件超过 100 MB 限制');
  let key = null;
  if (kind === 'image' && payload.aeskey) key = parseKey(payload.aeskey, true);
  else if (media.aes_key) key = parseKey(media.aes_key);
  else if (kind === 'file') throw new Error('微信文件缺少解密密钥');
  const fullUrl = String(media.full_url || '').trim();
  if (!fullUrl && !media.encrypt_query_param) throw new Error('微信消息缺少媒体下载地址');
  const url = fullUrl ? checkedCdnUrl(fullUrl) : cdnUrl(cdnBaseUrl, 'download', { encrypted_query_param: media.encrypt_query_param });
  const encrypted = await requestCdn(url, { method: 'GET' }, async response => {
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw mediaError('微信 CDN 下载失败（HTTP ' + response.status + '）', response.status);
    }
    return boundedResponse(response, MAX_MEDIA_BYTES + (key ? 16 : 0));
  });
  let plaintext = encrypted;
  if (key) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
      plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      throw new Error('微信媒体解密失败，请重试');
    }
  }
  if (plaintext.length > MAX_MEDIA_BYTES) throw new Error('文件超过 100 MB 限制');
  if (kind === 'file' && /^[a-f0-9]{32}$/i.test(String(payload.md5 || ''))
      && crypto.createHash('md5').update(plaintext).digest('hex') !== payload.md5.toLowerCase()) {
    throw new Error('微信文件校验失败，请重新发送');
  }
  return saveBuffer(plaintext, {
    name: kind === 'file' ? payload.file_name : undefined,
    kind,
    direction: 'inbound',
    directory
  });
}

module.exports = { MAX_MEDIA_BYTES, DEFAULT_CDN_BASE_URL, saveBuffer, getMedia, publicAttachment, uploadMedia, downloadItem };
