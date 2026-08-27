// 小鹈鹕核心 — HTTP 服务入口（装配见 core/api/rest.js）
'use strict';

const { createRestServer, VERSION } = require('./api/rest');

const PORT = parseInt(process.env.V3_PORT || '18791', 10);

function createServer(opts = {}) {
  return createRestServer(opts);
}

module.exports = { createServer, VERSION };

if (require.main === module) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`小鹈鹕用户端: http://127.0.0.1:${PORT}`);
  });
}
