// 兼容入口：dashboard 旧启动方式（node dashboard/server.mjs）改为启动核心服务
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createServer } = require('../core/server.js');
const PORT = parseInt(process.env.V3_PORT || '18791', 10);

createServer().listen(PORT, '127.0.0.1', () => {
  console.log(`小鹈鹕用户端: http://127.0.0.1:${PORT}`);
});
