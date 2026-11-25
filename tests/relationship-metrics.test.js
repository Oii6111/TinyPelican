'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRelationshipMetrics } = require('../core/memory/relationship-metrics');

const row = (sender, ts, content, type = 'text') => ({ sender, ts, content, type });

test('computes sessions, initiations, message symmetry and role reply latency', () => {
  const metrics = computeRelationshipMetrics([
    row('她', '2026-01-01T09:00:00Z', '早呀'),
    row('我', '2026-01-01T09:10:00Z', '早上好，今天怎么样？'),
    row('她', '2026-01-01T09:25:00Z', '还不错'),
    row('我', '2026-01-01T20:00:00Z', '晚安'),
    row('她', '2026-01-01T20:15:00Z', '晚安呀'),
    row('我', '2026-01-03T09:00:00Z', '周末见吗？'),
    row('她', '2026-01-03T09:40:00Z', '可以')
  ], { ownerName: '我', contactName: '她' });
  assert.equal(metrics.sample.includedRows, 7);
  assert.equal(metrics.sample.totalSessions, 3);
  assert.deepEqual(metrics.initiation, { ownerCount: 2, contactCount: 1, ownerShare: 2 / 3, contactShare: 1 / 3 });
  assert.equal(metrics.participants.owner.messageCount, 3);
  assert.equal(metrics.participants.contact.messageCount, 4);
  assert.equal(metrics.replyLatency.owner.sampleCount, 1);
  assert.equal(metrics.replyLatency.contact.sampleCount, 3);
  assert.equal(metrics.replyLatency.owner.medianMs, 600000);
  assert.equal(metrics.replyLatency.contact.medianMs, 900000);
  assert.equal(metrics.messageBalance.ownerToContactCountRatio, 3 / 4);
  assert.equal(metrics.sessions[0].twoSided, true);
});

test('excludes unknown and malformed rows, keeps non-text media out of readable character totals', () => {
  const metrics = computeRelationshipMetrics([
    row('我', '2026-01-01T09:00:00Z', '你好😊'),
    row('她', '2026-01-01T09:01:00Z', '😊', 'sticker'),
    row('陌生人', '2026-01-01T09:02:00Z', '不要纳入'),
    row('她', 'invalid', '坏时间'),
    row('我', '2026-01-01T09:03:00Z', '[图片]', 'image')
  ], { ownerName: '我', contactName: '她' });
  assert.equal(metrics.sample.includedRows, 3);
  assert.deepEqual(metrics.sample.excluded, { unknownSender: 1, invalidTimestamp: 1, emptyContent: 0 });
  assert.equal(metrics.participants.contact.stickerCount, 1);
  assert.equal(metrics.participants.contact.emojiCount, 0);
  assert.equal(metrics.participants.owner.imageCount, 1);
  assert.equal(metrics.participants.owner.readableChars, 3);
  assert.equal(metrics.participants.owner.emojiCount, 1);
  assert.equal(metrics.participants.contact.readableChars, 0);
  assert.equal(metrics.sample.sufficientForInteraction, false);
  assert.ok(metrics.interpretationGuardrails.some(text => text.includes('待观察假设')));
});

test('does not label a 70 percent initiation share as a diagnosis', () => {
  const metrics = computeRelationshipMetrics([
    row('我', '2026-01-01T09:00:00Z', '一'), row('她', '2026-01-01T09:01:00Z', '二'),
    row('我', '2026-01-02T09:00:00Z', '三'), row('我', '2026-01-03T09:00:00Z', '四'),
    row('我', '2026-01-04T09:00:00Z', '五'), row('她', '2026-01-04T09:01:00Z', '六'),
    row('我', '2026-01-05T09:00:00Z', '七'), row('我', '2026-01-06T09:00:00Z', '八'),
    row('她', '2026-01-06T09:01:00Z', '九'), row('我', '2026-01-07T09:00:00Z', '十')
  ], { ownerName: '我', contactName: '她' });
  assert.ok(metrics.initiation.ownerShare > 0.7);
  assert.equal(Object.hasOwn(metrics.initiation, 'diagnosis'), false);
  assert.match(metrics.sample.limitation, /不代表已读/);
});

test('explicit isOwner wins over the sender name and unknown senders stay out', () => {
  const metrics = computeRelationshipMetrics([
    { sender: '她', isOwner: true, ts: '2026-01-01T09:00:00Z', content: '我是本人' },
    { sender: '我', isOwner: false, ts: '2026-01-01T09:01:00Z', content: '我才是联系人' },
    { sender: '其他人', isOwner: null, ts: '2026-01-01T09:02:00Z', content: '身份未确认' }
  ], { ownerName: '我', contactName: '她' });
  assert.equal(metrics.participants.owner.messageCount, 1);
  assert.equal(metrics.participants.contact.messageCount, 1);
  assert.equal(metrics.sample.excluded.unknownSender, 1);
  assert.equal(metrics.sample.includedRows, 2);
});

test('splits sessions on an 8 hour gap and keeps the split configurable', () => {
  const rows = [
    row('我', '2026-01-01T09:00:00Z', '早'),
    row('她', '2026-01-01T10:00:00Z', '早呀'),
    row('我', '2026-01-01T19:30:00Z', '晚上好'),
    row('她', '2026-01-01T19:40:00Z', '晚上好')
  ];
  const defaultGap = computeRelationshipMetrics(rows, { ownerName: '我', contactName: '她' });
  assert.equal(defaultGap.sample.totalSessions, 2);
  assert.equal(defaultGap.parameters.sessionGapMs, 8 * 60 * 60 * 1000);
  const wide = computeRelationshipMetrics(rows, { ownerName: '我', contactName: '她', sessionGapMs: 24 * 60 * 60 * 1000 });
  assert.equal(wide.sample.totalSessions, 1);
});
