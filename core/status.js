// 小鹈鹕核心 — 全局状态（心跳 / 主动级别 / 未读数）
// 供顶部状态栏与 /api/status 使用。
'use strict';

const { getUnread } = require('./memory/stores/unread');

const state = {
  startedAt: null,
  lastBeatAt: null,
  nextBeatAt: null,
  intervalSec: 30,
  _timer: null
};

function touch() {
  const now = Date.now();
  state.lastBeatAt = new Date(now).toISOString();
  state.nextBeatAt = new Date(now + state.intervalSec * 1000).toISOString();
}

function startHeartbeat(intervalSec = 30) {
  if (state.startedAt) return;
  state.intervalSec = intervalSec;
  state.startedAt = new Date().toISOString();
  touch();
  state._timer = setInterval(touch, intervalSec * 1000);
  if (state._timer.unref) state._timer.unref();
}

function stopHeartbeat() {
  if (state._timer) clearInterval(state._timer);
  state._timer = null;
  state.startedAt = null;
}

function heartbeat() {
  return {
    online: !!state.startedAt,
    startedAt: state.startedAt,
    lastBeatAt: state.lastBeatAt,
    nextBeatAt: state.nextBeatAt,
    intervalSec: state.intervalSec
  };
}

function getStatus(cfg) {
  const c = cfg || {};
  return {
    heartbeat: heartbeat(),
    proactivity: {
      level: (c.proactivity && c.proactivity.level) || 'L2'
    },
    unread: getUnread()
  };
}

module.exports = { startHeartbeat, stopHeartbeat, touch, heartbeat, getStatus };
