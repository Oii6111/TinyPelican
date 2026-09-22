// 小鹈鹕 — 内置 DSH 自检 + 手工启动（排障用，前台运行，Ctrl+C 结束）
//
// 什么时候用它：微信/看板发起对话报 "fetch failed"、浏览器打开 http://127.0.0.1:3080 没反应，
// 说明 DSH 后端没起来。本脚本先在窗口里做一轮自检（安装目录、内置 DSH、安装路径、数据目录可否写、
// DSH profile、3080 端口），修掉已知的启动阻塞点，然后在前台启动 DSH 并打印日志，
// 日志同时追加到 <数据目录>\dsh.log。启动成功后会顺手把 WebUI 鉴权 cookie 存好，
// 小鹈鹕（看板/微信）在这个窗口开着的时候可以直接用。
//
// 安装包里的入口是同目录的 start-dsh.cmd（纯 ASCII 壳，双击即可）。
// 优先复用核心自己的启动逻辑（core/agent/dsh-web-client），这样模型配置、DSH_HOME、鉴权
// 都和应用内启动一致；万一安装目录里的核心是旧版本，退回到脚本自己拉起 `dsh web`。
//
// 已知坑（本脚本会自动修）：DSH 的 web profile 默认 patchReload: live，
// 而 live 需要 Node 的 --expose-internals；打包版用 Electron 当 Node 启动时没带这个 flag，
// 于是全新机器上 DSH 一启动就崩（--expose-internals is required for HMR service），3080 自然打不开。
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

// content 目录：由 start-dsh.cmd 通过 XIAOTIHU_CONTENT_DIR 指过来（脚本被放在别处时），
// 否则脚本可能在 <安装目录>\resources\content 下，也可能在仓库的 scripts\ 下。
function findContent() {
  const candidates = [__dirname, path.resolve(__dirname, '..')];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) return dir;
  }
  return candidates[0];
}

const CONTENT = process.env.XIAOTIHU_CONTENT_DIR || findContent();
const PORT = Number(process.env.XIAOTIHU_DSH_PORT || 3080) || 3080;
const BASE = `http://127.0.0.1:${PORT}`;
const BUNDLED_DSH = path.join(CONTENT, 'vendor', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const WAIT_MS = 180000;
// 核心默认只认 3080（base URL 由 DSH_WEB_URL 决定），这里先对齐，改端口调试时也不会错位
if (!process.env.DSH_WEB_URL) process.env.DSH_WEB_URL = BASE;

// —— 环境准备：与 app/main.js 的打包分支保持一致 ——
if (!process.env.XIAOTIHU_DATA_DIR) {
  const appData = process.env.APPDATA || '';
  if (appData) process.env.XIAOTIHU_DATA_DIR = path.join(appData, 'xiaotihu');
}
const dataDir = process.env.XIAOTIHU_DATA_DIR || '';
if (dataDir) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
}
const dshHome = process.env.DSH_HOME || (dataDir ? path.join(dataDir, 'dsh-home') : '');
if (dshHome) {
  process.env.DSH_HOME = dshHome;
  try { fs.mkdirSync(dshHome, { recursive: true }); } catch {}
}
if (!process.env.XIAOTIHU_DSH_BIN && fs.existsSync(BUNDLED_DSH)) process.env.XIAOTIHU_DSH_BIN = BUNDLED_DSH;

const logFile = dataDir ? path.join(dataDir, 'dsh.log') : '';
const ownState = { pid: null, exitCode: null, output: '' };
let ownChild = null;
let coreUsable = false;
let dshWeb = null;

// 窗口里打印的同时落一份日志：用户把 dsh.log 发过来就能定位
function say(line) {
  const text = String(line);
  console.log(text);
  if (!logFile) return;
  try { fs.appendFileSync(logFile, text + '\n', 'utf8'); } catch {}
}

function tryRequire(...rel) {
  try { return require(path.join(CONTENT, ...rel)); } catch { return null; }
}

function dshBin() {
  const client = tryRequire('core', 'agent', 'dsh-client');
  if (client && typeof client.findDshBin === 'function') {
    try { return client.findDshBin(); } catch { /* 继续用随包那份 */ }
  }
  if (process.env.XIAOTIHU_DSH_BIN && fs.existsSync(process.env.XIAOTIHU_DSH_BIN)) return process.env.XIAOTIHU_DSH_BIN;
  return fs.existsSync(BUNDLED_DSH) ? BUNDLED_DSH : '';
}

function maskKey(key) {
  const k = String(key || '');
  return k.length <= 8 ? '***' : `${k.slice(0, 4)}***${k.slice(-4)}`;
}

function readAppConfig() {
  if (!dataDir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); } catch { return null; }
}

function modelFromConfig(config) {
  const engine = (config && config.engine) || {};
  const prov = (engine.providers || {})[engine.provider];
  if (!prov) return null;
  const model = String(prov.model || '').trim();
  const baseUrl = String(prov.baseUrl || '').trim();
  const apiKey = String(prov.apiKey || '').trim();
  return { model, baseUrl, apiKey };
}

// 与 core/agent/dsh-client.js 的 writeGeneratedDshSettings 保持一致：
// DSH 靠 DSH_HOME/settings.yaml 里的这段知道该用哪个模型与 baseURL。
function writeDshSettings(home, model) {
  if (!model || !model.model || !model.baseUrl) return false;
  const quote = (value) => JSON.stringify(String(value));
  const lines = [
    'agent-default-model:',
    '  provider: deepseek-official',
    `  model: ${quote(model.model)}`,
    'llm-deepseek:',
    `  baseURL: ${quote(model.baseUrl)}`,
    '  apiKeyEnv: DEEPSEEK_API_KEY',
    '  models:',
    `    - id: ${quote(model.model)}`,
    `      name: ${quote(model.model)}`,
    '      contextWindow: 1000000'
  ];
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.yaml'), lines.join('\n') + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// 下面三段是 DSH 自己 initProfile 会写的文件（内容与 @deepseek-ai/dsh-app-boot 里的一字不差），
// 区别只有一处：web profile 的 patchReload 从 live 改成 startup。
// DSH 的 initProfile 只在 package.json 缺失时才动手，所以先建好就等于永久生效。
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;
const WEB_PROFILE_MANIFEST = {
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } }
};

// DSH 的 web profile 模板把 patchReload 设成 live，而 live 需要 Node 的 --expose-internals。
// 老版本核心拉起 DSH 时不带这个 flag，于是全新机器上 DSH 一启动就崩，3080 永远打不开。
// 这里把 profile 降到 startup（一次修好），之后连老版本核心也能正常拉起 DSH。
// 已经带上这个 flag 的新版本核心不用管（live reload 保留）。
function prepareWebProfile(home) {
  if (!home) return '跳过（没有 DSH_HOME）';
  try {
    const core = fs.readFileSync(path.join(CONTENT, 'core', 'agent', 'dsh-web-client.js'), 'utf8');
    if (core.includes('--expose-internals')) return '正常（核心自带 --expose-internals，live reload 可用）';
  } catch { /* 读不到核心源码就按需要修 */ }
  const dir = path.join(home, 'profiles', 'web');
  const manifest = path.join(dir, 'package.json');
  const notes = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(manifest)) {
      fs.writeFileSync(manifest, JSON.stringify(WEB_PROFILE_MANIFEST, null, 2) + '\n');
      notes.push('已按 DSH 模板创建（patchReload=startup）');
    } else {
      const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const profile = raw && raw.dsh && raw.dsh.profile;
      if (profile && profile.patchReload === 'live') {
        profile.patchReload = 'startup';
        fs.writeFileSync(manifest, JSON.stringify(raw, null, 2) + '\n');
        notes.push('已修：patchReload live → startup');
      }
    }
    // initProfile 的另外两个文件：只在缺失时补，不覆盖
    const patchPath = path.join(dir, 'cordis.patch.yml');
    if (!fs.existsSync(patchPath)) {
      fs.writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE);
      notes.push('补上缺失的 cordis.patch.yml');
    }
    const workspacePath = path.join(dir, 'pnpm-workspace.yaml');
    if (!fs.existsSync(workspacePath)) {
      fs.writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE);
      notes.push('补上缺失的 pnpm-workspace.yaml');
    }
    return notes.length ? notes.join('；') : '正常';
  } catch (e) {
    return '读取失败：' + String((e && e.message) || e);
  }
}

function portListening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function writeTest(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 拿启动日志里的 ?token= 换长期 cookie，落盘到 <数据目录>\dsh-web-auth.json，
// 让小鹈鹕的看板/微信也能连上这个手工启动的 DSH（否则会 401 unauthorized）。
async function saveWebCookie(token) {
  if (!dataDir || !token) return false;
  const file = path.join(dataDir, 'dsh-web-auth.json');
  try {
    const res = await fetch(`${BASE}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const headers = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    let cookie = '';
    for (const value of headers) {
      const pair = String(value || '').split(';')[0];
      if (pair.startsWith('dsh-auth-')) { cookie = pair; break; }
    }
    if (!cookie) return false;
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    all[BASE] = { cookie, savedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// 核心不可用时：脚本自己拉起 `dsh web`（带上 --expose-internals，live reload 也不怕）
function ownLaunch(bin) {
  ownChild = spawn(process.execPath, ['--expose-internals', bin, 'web', '--port', String(PORT), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true
  });
  ownState.pid = ownChild.pid;
  let token = '';
  const onData = (chunk) => {
    const text = String(chunk || '');
    process.stdout.write(text);
    ownState.output = (ownState.output + text).slice(-800);
    if (logFile) { try { fs.appendFileSync(logFile, text, 'utf8'); } catch {} }
    const m = text.match(/\?token=([A-Za-z0-9_-]{8,})/);
    if (m && !token) token = m[1];
  };
  ownChild.stdout.setEncoding('utf8');
  ownChild.stdout.on('data', onData);
  if (ownChild.stderr) {
    ownChild.stderr.setEncoding('utf8');
    ownChild.stderr.on('data', onData);
  }
  ownChild.on('exit', (code) => { ownState.exitCode = code; });
  ownChild.on('error', (e) => { ownState.exitCode = -1; say('spawn 失败：' + String((e && e.message) || e)); });

  return new Promise((resolve) => {
    const deadline = Date.now() + WAIT_MS;
    const tick = setInterval(async () => {
      if (await portListening(PORT, 500)) {
        clearInterval(tick);
        const cookie = await saveWebCookie(token);
        resolve({ ok: true, started: true, pid: ownChild.pid, cookie });
        return;
      }
      if (ownState.exitCode !== null) {
        clearInterval(tick);
        resolve({ ok: false, error: `DSH 进程退出（code=${ownState.exitCode}）` });
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(tick);
        resolve({ ok: false, error: `等待 ${Math.round(WAIT_MS / 1000)} 秒后 3080 端口仍不可达` });
      }
    }, 500);
  });
}

function stopDsh() {
  try {
    if (coreUsable && typeof dshWeb.stopWeb === 'function') dshWeb.stopWeb();
    else if (ownChild) ownChild.kill();
  } catch {}
}

// 安装目录里的核心可能是老版本：没有 dshStatus() 就只能靠端口探活
function coreStatus() {
  if (coreUsable && typeof dshWeb.dshStatus === 'function') {
    try { return dshWeb.dshStatus(); } catch {}
  }
  return null;
}

function keepAlive() {
  // DSH 死了就退出，别留一个看起来还活着的窗口
  let missed = 0;
  setInterval(async () => {
    const status = coreStatus();
    const state = status || ownState;
    if (state.exitCode !== null && state.exitCode !== undefined) {
      say('');
      say(`[DSH 已退出] code=${state.exitCode}${state.error ? '｜' + state.error : ''}`);
      process.exit(state.exitCode === 0 ? 0 : 1);
      return;
    }
    if (status) return;                    // 核心能给出状态，就以它为准
    // 拿不到状态（老版本核心）时用端口探活，连续两次探不到才算退出
    if (await portListening(PORT, 800)) { missed = 0; return; }
    missed += 1;
    if (missed >= 2) {
      say('');
      say('[DSH 已退出] 端口不再监听（安装目录里的核心是旧版本，没有状态接口）。上面的输出就是原因。');
      process.exit(1);
    }
  }, 3000);
}

async function main() {
  dshWeb = tryRequire('core', 'agent', 'dsh-web-client');
  coreUsable = !!(dshWeb && typeof dshWeb.launchWeb === 'function');

  say('');
  say('小鹈鹕：内置 DSH 自检 + 手工启动');
  say(`  时间        = ${new Date().toLocaleString()}`);
  say(`  运行器      = ${process.execPath}（Node ${process.version}）`);
  say(`  安装目录    = ${CONTENT}`);
  say(`  数据目录    = ${dataDir || '(未设置：按开发模式使用项目目录)'}`);
  say(`  DSH_HOME    = ${dshHome || '(未设置：DSH 会用默认 ~/.dsh)'}`);
  say(`  日志        = ${logFile || '(未设置)'}`);
  say(`  启动方式    = ${coreUsable ? '核心逻辑（模型配置/Key/鉴权一并交给 DSH）' : '脚本直接拉起 dsh web'}`);

  const bin = dshBin();
  say(`  DSH 入口    = ${bin || '(没找到)'}`);
  if (!bin) {
    say('');
    say('[x] 找不到 DSH。安装目录可能被安全软件清理过，重装一次小鹈鹕即可。');
    process.exitCode = 1;
    return;
  }

  const model = modelFromConfig(readAppConfig());
  say(`  模型        = ${(model && model.model) || '(未配置 —— 打开小鹈鹕「设置 → 模型服务」填模型和 Key)'}`);
  say(`  API Key     = ${(model && model.apiKey) ? `已配置（${maskKey(model.apiKey)}）` : '(未配置)'}`);

  if (CONTENT.length > 120) {
    say(`[!] 安装路径偏长（${CONTENT.length} 个字符），DSH 可能撞上 Windows 路径长度限制，建议装到更短的路径。`);
  }
  if (/[^\u0000-\u007F]/.test(CONTENT)) {
    say('[!] 安装路径里有中文/非 ASCII 字符，DSH 偶发启动失败，建议装到纯英文路径（例如 D:\\TinyPelican）。');
  }

  if (dshHome) {
    const probe = writeTest(dshHome);
    say(`  DSH_HOME 可写 = ${probe.ok ? '是' : '否｜' + probe.error}`);
    if (!probe.ok) {
      say('[x] DSH_HOME 写不进去，DSH 一定起不来：检查杀软的「受控文件夹访问」，或以当前用户身份重新安装。');
      process.exitCode = 1;
      return;
    }
    say(`  web profile = ${prepareWebProfile(dshHome)}`);
  }

  const busy = await portListening(PORT);
  say(`  ${PORT} 端口   = ${busy ? '已被监听' : '空闲'}`);
  if (busy) {
    say('');
    say(`[ok] ${PORT} 上已经有程序在监听（正常情况下就是 DSH），不用再启动一个。`);
    say(`    判断方法：浏览器打开 ${BASE}/ ，能出现 DSH 界面就说明它在跑。`);
    say(`    如果它其实不是 DSH，请先关掉占用 ${PORT} 的程序，再运行本脚本。`);
    return;
  }

  if (model && model.apiKey) process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || model.apiKey;
  if (dshHome) writeDshSettings(dshHome, model);

  say('');
  say('=== 启动内置 DSH（首次会在 DSH_HOME 下建 profile，可能要几十秒）===');
  const result = coreUsable
    ? await dshWeb.launchWeb({ port: PORT, base: BASE, waitMs: WAIT_MS })
    : await ownLaunch(bin);

  if (coreUsable) {
    const status = coreStatus();
    if (status && status.output) {
      say('--- DSH 输出 ---');
      say(String(status.output).trim());
      say('--- 输出结束 ---');
    }
  }

  if (!result.ok) {
    say('');
    say(`[x] DSH 没起来：${result.error || '未知原因'}`);
    if (logFile) say(`    日志：${logFile}`);
    process.exitCode = 1;
    return;
  }

  say('');
  if (result.started) {
    say('[ok] DSH 已启动');
    say(`    浏览器：${BASE}/`);
    if (result.cookie === false) say('[!] 没能自动保存 WebUI 鉴权 cookie：小鹈鹕若报 401，请把 DSH 启动日志里的 ?token=... 填到 config.json 的 agent.dsh.webToken');
    say('    现在小鹈鹕（看板 / 微信）可以直接用了。');
    say('    这个窗口就是 DSH 本体，别关它；按 Ctrl+C 结束。');
    keepAlive();
  } else {
    say('[ok] DSH 本来就在跑，不需要再启动一个。');
    say('    这个窗口可以直接关掉；如果小鹈鹕还是报 fetch failed，请把 dsh.log 发给我。');
  }
}

process.on('SIGINT', () => {
  say('');
  say('收到 Ctrl+C，停止 DSH……');
  stopDsh();
  process.exit(0);
});

main().catch((e) => {
  say('');
  say('[x] 启动 DSH 出错：' + String((e && e.stack) || e));
  process.exitCode = 1;
});
