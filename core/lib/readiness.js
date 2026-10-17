'use strict';

const path = require('path');

async function waitForCore({ base, root, dataDir, timeoutMs = 60000, isRunning = () => true, fetchImpl = fetch, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning()) throw new Error('核心进程已退出，请检查启动日志。');
    let health;
    try {
      const response = await fetchImpl(base + '/api/health', { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) });
      if (response.ok) health = await response.json();
    } catch {}
    if (health && health.ok && health.name === 'xiaotihu-core') {
      const normalize = directory => process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
      if (!health.projectRoot || normalize(health.projectRoot) !== normalize(root)
          || (dataDir && (!health.dataDir || normalize(health.dataDir) !== normalize(dataDir)))) {
        throw new Error('端口被其他目录或数据目录的小鹈鹕占用，请关闭旧实例后重试。');
      }
      return health;
    }
    await sleep(500);
  }
  throw new Error(`等待核心服务就绪超时（${timeoutMs / 1000} 秒），请检查启动日志。`);
}

module.exports = { waitForCore };
