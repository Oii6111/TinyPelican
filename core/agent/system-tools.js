'use strict';

const tasks = require('../memory/stores/tasks');
const schedules = require('../memory/stores/schedules');
const { readIntents } = require('../memory/stores/intents');
const chatDb = require('../memory/chat-db');

function compact(item, type) {
  return {
    id: item.id,
    type,
    title: item.title || item.summary || '',
    detail: item.detail || '',
    status: item.status || 'open',
    ...(item.dueAt ? { dueAt: item.dueAt } : {}),
    ...(item.nextAt ? { nextAt: item.nextAt } : {}),
    ...(item.startAt ? { startAt: item.startAt } : {}),
    ...(item.endAt ? { endAt: item.endAt } : {})
  };
}

function queryRecords(scope = 'overview', { includeDone = false } = {}) {
  const allTasks = tasks.listTasks();
  const taskItems = includeDone ? allTasks : allTasks.filter((x) => x.status !== 'done');
  const todos = taskItems.filter((x) => x.type !== 'reminder').map((x) => compact(x, 'todo'));
  const reminders = taskItems.filter((x) => x.type === 'reminder').map((x) => compact(x, 'reminder'));
  const scheduleItems = schedules.listSchedules().filter((x) => includeDone || x.status !== 'done').map((x) => compact(x, 'schedule'));
  const pendingIntents = readIntents().filter((x) => x.status === 'pending_confirm').map((x) => compact(x, 'pending_intent'));
  const result = { todos, reminders, schedules: scheduleItems, pendingIntents };
  if (scope === 'todo') return { todos, reminders: [], schedules: [], pendingIntents: [] };
  if (scope === 'reminder') return { todos: [], reminders, schedules: [], pendingIntents: [] };
  if (scope === 'schedule') return { todos: [], reminders: [], schedules: scheduleItems, pendingIntents: [] };
  if (scope === 'pending_intent') return { todos: [], reminders: [], schedules: [], pendingIntents };
  return result;
}

module.exports = { queryRecords };

function searchChat(query, { contact = '', limit = 50 } = {}) {
  return chatDb.searchMessages(query, { contact, limit });
}

function getContactContext(contact, options = {}) {
  return chatDb.contactContext(contact, options);
}

function findMentionedContact(message) {
  const text = String(message || '');
  const matches = chatDb.listMembers('').flatMap((member) => [member.remark, member.name]
    .map((label) => String(label || '').trim())
    .filter((label) => label.length >= 2 && text.includes(label))
    .map((label) => ({ member, label })));
  matches.sort((left, right) => right.label.length - left.label.length);
  if (!matches.length) return null;
  const best = matches.filter((match) => match.label.length === matches[0].label.length);
  return new Set(best.map((match) => match.member.id)).size === 1 ? best[0].member : null;
}

module.exports.searchChat = searchChat;
module.exports.getContactContext = getContactContext;
module.exports.findMentionedContact = findMentionedContact;
