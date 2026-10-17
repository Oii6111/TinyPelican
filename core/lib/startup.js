'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { projectRoot } = require('./paths');

const MIN_NODE = '22.13.0';

function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`需要 Node.js >=${MIN_NODE}（推荐 Node 24 LTS），当前为 ${version}。内置 SQLite 在 Node 22.13 起无需实验开关。`);
  }
}

function workspaceId(root) {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
}

function userDirectories(env = process.env, home = os.homedir()) {
  return [env.LOCALAPPDATA, env.APPDATA, home && path.join(home, '.local', 'share')].filter(Boolean);
}

function ensureWritableDirectory(directory, filesystem = fs) {
  filesystem.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.tinypelican-write-${crypto.randomUUID()}`);
  filesystem.writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  filesystem.unlinkSync(probe);
}

function selectWritableDirectory(candidates, { label = '数据目录', filesystem = fs, childDirectory = '' } = {}) {
  const failures = [];
  for (const candidate of [...new Set(candidates.filter(Boolean).map(directory => path.resolve(directory)))]) {
    try {
      ensureWritableDirectory(candidate, filesystem);
      if (childDirectory) ensureWritableDirectory(path.join(candidate, childDirectory), filesystem);
      return candidate;
    } catch (error) {
      failures.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  throw new Error(`${label}不可写，请指定有写入权限的目录。\n${failures.join('\n')}`);
}

function initializeRuntime({ root = projectRoot(), env = process.env, filesystem = fs, home = os.homedir(), packaged = false, warn = console.warn } = {}) {
  assertNodeVersion();
  const explicit = env.XIAOTIHU_DATA_DIR;
  const preferred = packaged ? path.join(env.APPDATA || home, 'xiaotihu') : root;
  const fallbacks = userDirectories(env, home).map(directory => path.join(directory, packaged ? 'TinyPelican' : 'TinyPelican-dev', ...(packaged ? [] : [workspaceId(root)]), 'data'));
  const directory = selectWritableDirectory(explicit ? [explicit] : [preferred, ...fallbacks], { filesystem, label: 'XIAOTIHU_DATA_DIR' });
  env.XIAOTIHU_DATA_DIR = directory;
  if (!explicit && directory !== path.resolve(preferred)) warn(`[启动] 项目目录不可写，数据目录改为 ${directory}`);
  const config = path.join(directory, 'config.json');
  try {
    filesystem.copyFileSync(path.join(root, 'config.example.json'), config, fs.constants.COPYFILE_EXCL);
    warn(`[启动] 已创建 ${config}，请在「设置 → 模型服务」填写 API Key 与模型名。`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error(`无法初始化配置 ${config}: ${error.message}`);
  }
  if (!env.DSH_HOME) env.DSH_HOME = path.join(directory, packaged || directory !== path.resolve(root) ? 'dsh-home' : 'agent/dsh-home');
  selectWritableDirectory([env.DSH_HOME], { filesystem, label: 'DSH_HOME' });
  return { dataDir: directory, config, dshHome: env.DSH_HOME };
}

module.exports = { MIN_NODE, assertNodeVersion, workspaceId, userDirectories, ensureWritableDirectory, selectWritableDirectory, initializeRuntime };

if (require.main === module) {
  try {
    console.log(JSON.stringify(initializeRuntime()));
  } catch (error) {
    console.error(`[启动失败] ${error.message}`);
    process.exitCode = 1;
  }
}
