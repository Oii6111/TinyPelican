// 小鹈鹕核心 — 通道契约
// 每个通道实现 connect/stop/send，通过 onMessage 上行消息；后续新增 QQ/飞书/邮件只需按此契约实现。
'use strict';

function createChannel({ name, connect, stop, send }) {
  if (!name || typeof connect !== 'function' || typeof stop !== 'function' || typeof send !== 'function') {
    throw new Error('通道必须实现 name/connect/stop/send');
  }
  return { name, connect, stop, send };
}

module.exports = { createChannel };
