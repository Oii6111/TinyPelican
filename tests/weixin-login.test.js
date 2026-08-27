'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaotihu-wx-'));
process.env.XIAOTIHU_DATA_DIR = tmp;

const login = require('../core/channels/weixin/login');
const { stringifyToml, parseToml } = require('../core/lib/toml');

function stubFetch() {
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('get_bot_qrcode')) {
      return { ok: true, json: async () => ({ qrcode: 'qr123', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' }) };
    }
    if (u.includes('get_qrcode_status')) {
      return {
        ok: true,
        json: async () => ({
          status: 'confirmed',
          bot_token: 'ilb_test',
          ilink_bot_id: 'bot1',
          ilink_user_id: 'u1',
          baseurl: 'https://region.weixin.qq.com'
        })
      };
    }
    throw new Error('unexpected url: ' + u);
  };
  return seen;
}

test('扫码登录流程：start -> check(confirmed) -> confirm 写入 config.toml', async () => {
  const seen = stubFetch();
  const key = login.startLogin();

  const s = await login.stepStart(key);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.qrcodeUrl, 'https://liteapp.weixin.qq.com/q/abc');

  const c = await login.stepCheck(key);
  assert.strictEqual(c.status, 'confirmed');

  const done = await login.stepConfirm(key);
  assert.strictEqual(done.ok, true);

  const creds = login.readCredentials();
  assert.strictEqual(creds.bot_token, 'ilb_test');
  assert.strictEqual(creds.user_id, 'u1');
  assert.ok(seen.some((u) => u.includes('get_bot_qrcode')));
  assert.ok(seen.some((u) => u.includes('get_qrcode_status')));
});

test('TOML 读写往返', () => {
  const obj = { weixin: { bot_token: 'ilb_x', account_id: 'a', base_url: 'https://x', user_id: 'u' } };
  assert.deepStrictEqual(parseToml(stringifyToml(obj)), obj);
});
