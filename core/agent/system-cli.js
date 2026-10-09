'use strict';

const { queryRecords, getContactContext } = require('./system-tools');

const [command, value = 'overview', contact = ''] = process.argv.slice(2);
if (!['query', 'search-chat', 'contact-context', 'list-contacts'].includes(command)) {
  process.stderr.write('Usage: node core/agent/system-cli.js query <scope> | search-chat <keyword> [contact] | contact-context <contact or remark> | list-contacts [query]\n');
  process.exitCode = 2;
} else if (command === 'search-chat') {
  const { searchChat } = require('./system-tools');
  process.stdout.write(JSON.stringify({ ok: true, messages: searchChat(value, { contact }) }));
} else if (command === 'contact-context') {
  const context = getContactContext(value);
  process.stdout.write(JSON.stringify({ ok: !!context, context: context || null }));
} else if (command === 'list-contacts') {
  const chatDb = require('../memory/chat-db');
  const contacts = chatDb.listMembers(value === 'overview' ? '' : value).map(({ name, remark }) => ({ name, remark }));
  process.stdout.write(JSON.stringify({ ok: true, contacts }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, ...queryRecords(value) }));
}
