// 小鹈鹕 Agent 后端 — DSH Headless 客户端
// 负责定位本机 DSH、以自定义 profile 启动 headless 任务，
// 并解析 DSH 输出的事件流（JSONL），供 WebUI 展示 Agent 的思考/工具调用过程。
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const STREAM_MARKER = '@@DSH_EVENT@@';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DSH_HOME = path.join(PROJECT_ROOT, 'agent', 'dsh-home');
const DEFAULT_PROFILE = 'xiaotihu';
// Agent 默认工作区 = 项目根目录（后续记忆/文件全部落在这个文件夹里）
const DEFAULT_WORKSPACE = PROJECT_ROOT;

function ensureWorkspace(dir) {
  if (!dir) dir = DEFAULT_WORKSPACE;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 用户本机 DSH 目录（~/.dsh）
function userDshHome() {
  const base = process.env.USERPROFILE || process.env.HOME || '';
  return base ? path.join(base, '.dsh') : null;
}

// 把用户本机 DSH 的 settings.yaml / .credentials.yaml 同步到项目 DSH_HOME，
// 这样 DSH 子进程即使 DSH_HOME 指向项目目录，也能读到本机已配置的 provider 与 API key。
function syncDshHomeConfig(dshHome) {
  const src = userDshHome();
  if (!src || !fs.existsSync(src)) return;
  fs.mkdirSync(dshHome, { recursive: true });
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    const s = path.join(src, name);
    const d = path.join(dshHome, name);
    try {
      if (!fs.existsSync(s)) continue;
      // 每次都以本机 DSH 配置为准；若小鹈鹕设置了 engine，随后 writeGeneratedDshSettings 再覆盖。
      fs.copyFileSync(s, d);
    } catch {}
  }
}

// 把用户在小鹈鹕设置里选的 provider/model 翻译成 DSH 的 settings.yaml。
// DSH 的 llm-deepseek 支持任意 OpenAI 兼容 /chat/completions 端点，
// 因此统一用 deepseek-official 路由承载用户配置的模型。
function yamlQuote(s) {
  return JSON.stringify(String(s));
}

function writeGeneratedDshSettings(dshHome, config) {
  if (!config || !config.engine) return;
  const provider = config.engine.provider;
  const prov = (config.engine.providers || {})[provider];
  if (!prov || !prov.model || !prov.baseUrl) return;

  const model = String(prov.model).trim();
  const baseUrl = String(prov.baseUrl).trim();
  if (!model || !baseUrl) return;

  const lines = [
    'agent-default-model:',
    '  provider: deepseek-official',
    `  model: ${yamlQuote(model)}`,
    'llm-deepseek:',
    `  baseURL: ${yamlQuote(baseUrl)}`,
    '  apiKeyEnv: DEEPSEEK_API_KEY',
    '  models:',
    `    - id: ${yamlQuote(model)}`,
    `      name: ${yamlQuote(model)}`,
    '      contextWindow: 1000000'
  ];
  try {
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(path.join(dshHome, 'settings.yaml'), lines.join('\n') + '\n', 'utf8');
  } catch {}
}

// 构造 DSH 子进程环境变量；同时把本机 DSH 配置同步到项目 DSH_HOME。
function buildDshEnv(dshHome, config) {
  syncDshHomeConfig(dshHome);
  // 用户在小鹈鹕设置里配置了模型时，用该模型覆盖 DSH 默认模型
  writeGeneratedDshSettings(dshHome, config);
  const env = {
    ...process.env,
    DSH_HOME: dshHome
  };
  if (config && config.engine) {
    const provider = config.engine.provider;
    const prov = (config.engine.providers || {})[provider];
    // 不管 provider 名字是什么，都通过 DEEPSEEK_API_KEY 传给 DSH 的 deepseek-official 路由
    if (prov && prov.apiKey && !env.DEEPSEEK_API_KEY) {
      env.DEEPSEEK_API_KEY = prov.apiKey;
    }
  }
  return env;
}

// 定位 dsh 的 lib/bin.js：
// 1. 显式 DSH_BIN
// 2. 作为 node_modules 依赖被安装（推荐，用户 npm install 后自动可用）
// 3. 开发环境回退：扫描 npx 缓存里已有的 @deepseek-ai/dsh
function findDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;

  try {
    const resolved = require.resolve('@deepseek-ai/dsh/lib/bin.js');
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}

  const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  if (fs.existsSync(npxRoot)) {
    let best = null;
    let bestTime = 0;
    for (const dir of fs.readdirSync(npxRoot)) {
      const p = path.join(npxRoot, dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (fs.existsSync(p)) {
        const t = fs.statSync(p).mtimeMs;
        if (t > bestTime) {
          bestTime = t;
          best = p;
        }
      }
    }
    if (best) return best;
  }

  throw new Error('未找到 DSH（@deepseek-ai/dsh）。请先执行 npm install，或设置 DSH_BIN 环境变量。');
}

// 把一行 stdout 转成事件对象；不是事件流的行返回 null。
function parseEventLine(line) {
  if (!line.startsWith(STREAM_MARKER + ' ')) return null;
  try {
    return JSON.parse(line.slice(STREAM_MARKER.length + 1));
  } catch {
    return null;
  }
}

function isEpermError(e) {
  if (!e) return false;
  return e.code === 'EPERM' || /EPERM/i.test(String(e.message || ''));
}

// 从文件内容中逐行解析 DSH 事件与普通输出
function parseOutputFile(file) {
  const events = [];
  const outputLines = [];
  if (!fs.existsSync(file)) return { events, outputLines };
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const ev = parseEventLine(line);
    if (ev) events.push(ev);
    else outputLines.push(line);
  }
  return { events, outputLines };
}

// 主路径：管道实时捕获 stdout/stderr（WebUI 可实时看到事件）
function runDshTaskWithPipes({
  task,
  cwd,
  profile = DEFAULT_PROFILE,
  dshHome = DEFAULT_DSH_HOME,
  config = null,
  onEvent = () => {},
  onOutput = () => {},
  timeoutMs = 10 * 60 * 1000
} = {}) {
  return new Promise((resolve, reject) => {
    const bin = findDshBin();
    const workdir = ensureWorkspace(cwd);

    if (!task || !String(task).trim()) {
      return reject(new Error('任务文本不能为空'));
    }

    const child = spawn(process.execPath, [bin, '--profile', profile, String(task)], {
      cwd: workdir,
      env: buildDshEnv(dshHome, config),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const events = [];
    const outputLines = [];
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let timer = null;

    const finish = (err, exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const text = outputLines.join('\n').trim();
      const stderr = stderrBuf.trim();
      if (err || exitCode !== 0) {
        const msg = (err && err.message) || stderr || ('DSH 进程退出码 ' + exitCode);
        const fullError = new Error(msg);
        fullError.exitCode = exitCode;
        fullError.stderr = stderr;
        return reject(fullError);
      }
      resolve({ ok: true, text, events, exitCode, stderr });
    };

    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('DSH Agent 任务超时'), null);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        const ev = parseEventLine(line);
        if (ev) {
          events.push(ev);
          onEvent(ev);
        } else {
          outputLines.push(line);
          onOutput(line);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
    });

    child.on('error', (e) => {
      finish(e, null);
    });

    child.on('exit', (code) => {
      if (!settled) finish(null, code);
    });
  });
}

// 降级路径：某些受限环境禁止管道（spawn EPERM）。
// 把 stdout/stderr 直接接到文件，同时轮询文件实现“接近实时”的事件流。
function runDshTaskWithFiles({
  task,
  cwd,
  profile = DEFAULT_PROFILE,
  dshHome = DEFAULT_DSH_HOME,
  config = null,
  onEvent = () => {},
  onOutput = () => {},
  timeoutMs = 10 * 60 * 1000
} = {}) {
  return new Promise((resolve, reject) => {
    const bin = findDshBin();
    const workdir = ensureWorkspace(cwd);

    if (!task || !String(task).trim()) {
      return reject(new Error('任务文本不能为空'));
    }

    const tmpDir = fs.mkdtempSync(path.join(workdir, '.dsh-tmp-'));
    const outFile = path.join(tmpDir, 'stdout.txt');
    const errFile = path.join(tmpDir, 'stderr.txt');
    const outFd = fs.openSync(outFile, 'w');
    const errFd = fs.openSync(errFile, 'w');

    const child = spawn(process.execPath, [bin, '--profile', profile, String(task)], {
      cwd: workdir,
      env: buildDshEnv(dshHome, config),
      windowsHide: true,
      stdio: ['ignore', outFd, errFd]
    });

    const events = [];
    const outputLines = [];
    let settled = false;
    let timer = null;
    let pumpTimer = null;
    let processedLineCount = 0;

    const processLine = (line) => {
      const ev = parseEventLine(line);
      if (ev) {
        events.push(ev);
        onEvent(ev);
      } else {
        outputLines.push(line);
        onOutput(line);
      }
    };

    // 增量读取 stdout 文件：每次重读全文并按“完整行”推进，
    // 避免按字节偏移时把 UTF-8 多字节字符从中间切断。
    const pump = (final = false) => {
      if (settled || !fs.existsSync(outFile)) return;
      let text = '';
      try {
        text = fs.readFileSync(outFile, 'utf8');
      } catch { return; }
      const lines = text.split('\n');
      const completeCount = final ? lines.length : (text.endsWith('\n') ? lines.length : lines.length - 1);
      while (processedLineCount < completeCount) {
        const raw = lines[processedLineCount].replace(/\r$/, '');
        processedLineCount++;
        if (raw) processLine(raw);
      }
    };

    const finish = (err, exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pumpTimer) clearInterval(pumpTimer);
      try { fs.closeSync(outFd); } catch {}
      try { fs.closeSync(errFd); } catch {}
      // 处理最后可能没有换行符的剩余行
      pump(true);
      const text = outputLines.join('\n').trim();
      const stderr = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').trim() : '';
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      if (err || exitCode !== 0) {
        const msg = (err && err.message) || stderr || ('DSH 进程退出码 ' + exitCode);
        const fullError = new Error(msg);
        fullError.exitCode = exitCode;
        fullError.stderr = stderr;
        return reject(fullError);
      }
      resolve({ ok: true, text, events, exitCode, stderr });
    };

    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('DSH Agent 任务超时'), null);
    }, timeoutMs);

    pumpTimer = setInterval(pump, 200);

    child.on('error', (e) => {
      finish(e, null);
    });

    child.on('exit', (code) => {
      if (!settled) finish(null, code);
    });
  });
}

/**
 * 运行一个 DSH headless Agent 任务。
 * 优先使用管道实时读取；若被环境禁止（EPERM）则自动降级为文件输出。
 */
async function runDshTask(opts) {
  try {
    return await runDshTaskWithPipes(opts);
  } catch (e) {
    if (isEpermError(e)) {
      return runDshTaskWithFiles(opts);
    }
    throw e;
  }
}

module.exports = { runDshTask, findDshBin, parseEventLine, DEFAULT_DSH_HOME, DEFAULT_PROFILE, DEFAULT_WORKSPACE };
