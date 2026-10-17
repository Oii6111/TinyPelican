'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanText, cleanHtml } = require('../core/email/parser');
const { normalizeAnalysis, normalizeContact, parseJsonObject, emailConfig, unknownReviewPrompt } = require('../core/email/service');
const { createEmailDb } = require('../core/email/email-db');

test('email parser removes quoted history and unsafe HTML', () => {
  assert.equal(cleanText('当前内容\n> quoted\n\n-----Original Message-----\nold'), '当前内容');
  const html = cleanHtml('<div onclick="bad()">ok</div><script>alert(1)</script><a href="javascript:bad()">x</a>');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('onclick'));
  assert.ok(!html.includes('javascript:'));
});

test('email analysis is constrained to supported categories and actions', () => {
  const value = normalizeAnalysis({ category: 'important', importance: 2, summary: '  follow up ', action_candidates: [{ type: 'schedule', title: 'meeting', confidence: 0.9 }, { type: 'bad', title: '' }] });
  assert.deepEqual(value, { category: 'important', importance: 1, summary: 'follow up', action_candidates: [{ type: 'schedule', title: 'meeting', dueAt: '', detail: '', confidence: 0.9, reason: '' }] });
  assert.equal(normalizeAnalysis({ category: 'ads', action_candidates: [{ type: 'todo', title: 'ignore' }] }).action_candidates.length, 0);
  assert.deepEqual(parseJsonObject('```json\n{"category":"noise"}\n```'), { category: 'noise' });
});

test('unknown email classification gets a separate agent review prompt', () => {
  const prompt = unknownReviewPrompt({ subject: 'Notice', from: { address: 'sender@example.com' }, date: '2026-10-12', text: 'Message body' }, { category: 'unknown' });
  assert.match(prompt, /重新阅读/);
  assert.match(prompt, /important、ads、noise 还是 unknown/);
  assert.match(prompt, /Notice/);
});

test('email config uses one account and secure TLS defaults', () => {
  const cfg = emailConfig({ email: { enabled: true, imap: { host: 'imap.example', username: 'a', password: 'p' } } });
  assert.equal(cfg.accountId, 'default');
  assert.equal(cfg.initialDays, 30);
  assert.equal(cfg.imap.port, 993);
  assert.equal(cfg.imap.rejectUnauthorized, true);
});

test('email database deduplicates messages and tracks analysis jobs', () => {
  const emailDb = createEmailDb(':memory:');
  try {
    emailDb.ensureAccount('default', 'owner@example.com');
    emailDb.setAccountStatus('default', 'connected');
    assert.equal(emailDb.getAccount('default').address, 'owner@example.com');
    const first = emailDb.insertMessage({ accountId: 'default', folder: 'INBOX', uidValidity: 4, uid: 9, subject: 'Hello', text: 'Body' });
    const duplicate = emailDb.insertMessage({ accountId: 'default', folder: 'INBOX', uidValidity: 4, uid: 9, subject: 'Hello', text: 'Body' });
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    const jobs = emailDb.claimJobs(1);
    assert.equal(jobs.length, 1);
    emailDb.updateAnalysis(first.id, { category: 'important', importance: 0.9, summary: 'Body', analysisStatus: 'done', contactStatus: 'pending', contactCandidates: ['A', 'B'] });
    const message = emailDb.getMessage(first.id);
    assert.equal(message.contactStatus, 'pending');
    assert.deepEqual(message.contactCandidates, ['A', 'B']);
    assert.equal(emailDb.listMessages({ important: 'false' }).messages.length, 0);
  } finally {
    emailDb.close();
  }
});

test('ambiguous email matches remain pending instead of being auto-linked', () => {
  assert.deepEqual(normalizeContact([{ name: 'A' }, { name: 'B' }]), { contact: '', status: 'pending', candidates: ['A', 'B'] });
  assert.deepEqual(normalizeContact([{ name: 'A' }]), { contact: 'A', status: 'linked', candidates: ['A'] });
});
