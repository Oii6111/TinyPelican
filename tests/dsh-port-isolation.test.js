'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dshWeb = require('../core/agent/dsh-web-client');

test('bundled DSH uses a separate port and refuses an unrelated listener', async (context) => {
  assert.equal(dshWeb.DEFAULT_BASE, 'http://127.0.0.1:18792');
  const server = http.createServer((_request, response) => {
    response.writeHead(401);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const port = server.address().port;
  const result = await dshWeb.launchWeb({ port, base: `http://127.0.0.1:${port}`, waitMs: 1000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /已被其他进程占用/);
});
