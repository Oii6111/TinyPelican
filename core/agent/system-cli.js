'use strict';

const { queryRecords, getContactContext } = require('./system-tools');

const [command, value = 'overview', contact = ''] = process.argv.slice(2);
if (!['query', 'search-chat', 'contact-context'].includes(command)) {
  process.stderr.write('Usage: node core/agent/system-cli.js query <scope> | search-chat <keyword> [contact] | contact-context <contact>\n');
  process.exitCode = 2;
} else if (command === 'search-chat') {
  const { searchChat } = require('./system-tools');
  process.stdout.write(JSON.stringify({ ok: true, messages: searchChat(value, { contact }) }));
} else if (command === 'contact-context') {
  const context = getContactContext(value);
  process.stdout.write(JSON.stringify({ ok: !!context, context: context || null }));
} else {
  process.stdout.write(JSON.stringify({ ok: true, ...queryRecords(value) }));
}
