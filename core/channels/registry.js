'use strict';

const notificationChannels = new Map();

function registerNotificationChannel(definition) {
  if (!definition || !definition.id || typeof definition.send !== 'function') throw new TypeError('通知渠道必须提供 id 和 send');
  notificationChannels.set(String(definition.id), {
    id: String(definition.id),
    direction: definition.direction || 'outbound',
    label: definition.label || definition.id,
    send: definition.send
  });
}

function getNotificationChannel(id) { return notificationChannels.get(String(id || '')) || null; }
function listNotificationChannels() { return [...notificationChannels.values()].map(({ send, ...channel }) => channel); }

module.exports = { registerNotificationChannel, getNotificationChannel, listNotificationChannels };
