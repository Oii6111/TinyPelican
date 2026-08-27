const { spawnSync } = require('child_process');
const path = require('path');
const entry = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
const args = [
  'cron', 'add',
  '--name', 'xiaotihu-remind',
  '--every', '15m',
  '--command-argv', JSON.stringify(['node', path.join(__dirname, 'remind.js')]),
  '--command-cwd', __dirname,
  '--no-deliver',
  '--timeout-seconds', '60',
  '--json'
];
const r = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 60000, stdio: 'inherit' });
console.log('status:', r.status);
if (r.error) console.log('error:', r.error.message);
