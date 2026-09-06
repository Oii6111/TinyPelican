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

module.exports.searchChat = searchChat;
module.exports.getContactContext = getContactContext;
