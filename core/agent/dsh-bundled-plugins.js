// 小鹈鹕 — 随包内置的 DSH 插件（profile 级）
//
// 这里的「随包内置」不等于「塞进 DSH 自己的 node_modules」：那些目录归 DSH 安装包所有，
// 升级会被覆盖，而且 DSH 的插件管理器只认 profile。小鹈鹕的做法是：
//
//   1. 插件源码随安装包发出去（resources/content/agent/dsh-plugins/<名称>/）；
//   2. 首次启动把它复制进 DSH 的 web profile（$DSH_HOME/profiles/web/plugins/<名称>/）；
//   3. 在 profile 的 package.json 里登记成 file: 依赖 + 一个 bundle，再用 dsh 自带的
//      `dsh plugin install` 让 pnpm 建好 node_modules 链接（离线，只读本地目录）。
//
// 这样插件跟着产品走，用户装完就能用；同时它仍然是一个正常的 profile 插件，
// 用户可以像别的插件一样在「插件」页里看到、停用、或跟着 DSH 升级。
//
// 设计约束：
//   - 只在需要时动手（manifest 已登记且 node_modules 里能解析到就什么都不做）；
//   - 失败绝不影响启动：装不上就记一条日志，界面少一个入口，其它照常；
//   - 用户在「插件」页把市场（dshmarket）自己升级/换源，本模块不碰它的依赖记录。
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { spawnSync } = require('child_process');

/** 随包插件清单。sourceDir 相对 content 根目录（dev 下就是仓库根）。 */
const BUNDLED_PROFILE_PLUGINS = [
  {
    name: 'tinypelican-dsh-market',
    sourceDir: path.join('agent', 'dsh-plugins', 'tinypelican-market')
  }
];

const REQUIRED_PROFILE_PACKAGES = [
  { name: 'dshmarket', spec: '^1.66.47' }
];

/** profile 里存放本地插件的目录（相对 profile 目录）。 */
const PROFILE_PLUGINS_DIR = 'plugins';

/** 复制时跳过的开发期产物。 */
const SKIP_COPY = new Set(['.git', 'node_modules', 'src', 'test', 'tests', '*.tsbuildinfo']);

/**
 * 读取随包市场包的实际版本（vendor/node_modules/<name>），拿不到就退回清单里的 spec。
 * @param {string} dshBin dsh 入口
 * @param {{ name: string, spec: string }} pkg 包名与版本说明
 * @returns {string}
 */
function shippedVersion(dshBin, pkg) {
  try {
    const vendorRoot = path.resolve(path.dirname(dshBin), '..', '..', '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(vendorRoot, pkg.name, 'package.json'), 'utf8'));
    if (manifest && typeof manifest.version === 'string' && manifest.version) return manifest.version;
  } catch {}
  return String((pkg && pkg.spec) || '*');
}

/**
 * 让内置 DSH「认领」随包市场包。
 *
 * DSH 给 profile 的模块解析是两段式：先在安装作用域里找，再找 profile。
 * 但安装作用域不是「安装目录里有什么」，而是顺着 @deepseek-ai/dsh 自己的
 * dependencies 走一遍依赖图（dsh-app-boot 的 collectInstallationScopePackages）。
 * dshmarket 只是被我们放在 vendor/node_modules 里当邻居，不在那张图里，
 * 于是 profile 的 bundles 一登记就解析不到，DSH 启动时报：
 *   dsh: warning: 1 entry did not activate
 *   dsh-market (dshmarket): failed to import ... Cannot find package 'dshmarket'
 *
 * 这里把随包市场包写进内置 DSH 的 dependencies（幂等），它才会被带进安装作用域。
 * 只动我们自己随包的那份 DSH，不碰用户的 profile 依赖记录。
 * @param {object} options
 * @param {string} options.dshBin dsh 入口
 * @param {Array<{ name: string, spec: string }>} [options.packages] 需要认领的包
 * @returns {{ changed: boolean, manifestPath: string, added: string[], error: string, missing: boolean }}
 */
function ensureInstallationDependencies({ dshBin, packages = REQUIRED_PROFILE_PACKAGES } = {}) {
  const result = { changed: false, manifestPath: '', added: [], error: '', missing: false };
  if (!dshBin) {
    result.error = '缺少 dsh 入口';
    return result;
  }
  const manifestPath = path.resolve(path.dirname(dshBin), '..', 'package.json');
  result.manifestPath = manifestPath;
  // 没有内置 DSH 的清单（开发态 / 精简安装）：不是错误，只是没得改
  if (!fs.existsSync(manifestPath)) {
    result.missing = true;
    return result;
  }
  let manifest;
  try {
    // 有些工具写出来的 package.json 带 BOM，JSON.parse 会直接报错
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    result.error = `读不到内置 DSH 的 package.json（${String((error && error.message) || error)}）`;
    return result;
  }
  if (!manifest || typeof manifest !== 'object') {
    result.error = '内置 DSH 的 package.json 不是对象';
    return result;
  }
  if (!manifest.dependencies || typeof manifest.dependencies !== 'object') manifest.dependencies = {};

  for (const pkg of packages) {
    if (typeof manifest.dependencies[pkg.name] === 'string') continue;
    manifest.dependencies[pkg.name] = shippedVersion(dshBin, pkg);
    result.added.push(pkg.name);
  }
  if (!result.added.length) return result;

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    result.changed = true;
  } catch (error) {
    result.added = [];
    result.error = `内置 DSH 的 package.json 不可写（${String((error && error.message) || error)}）`;
  }
  return result;
}

/**
 * 递归复制目录，只写真正变了的文件（产品升级时 profile 里那份要跟着更新）。
 * 逐项判断，不做 shell 调用（Windows 路径更省心）。
 * @param {string} from 源目录
 * @param {string} to 目标目录
 * @returns {{ files: number, changed: boolean }} 处理的文件数与是否有内容变化
 */
function copyTree(from, to) {
  let files = 0;
  let changed = false;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_COPY.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const nested = copyTree(src, dst);
      files += nested.files;
      changed = changed || nested.changed;
    } else if (entry.isFile()) {
      const next = fs.readFileSync(src);
      let same = false;
      try {
        same = fs.readFileSync(dst).equals(next);
      } catch {
        same = false;
      }
      if (!same) {
        fs.writeFileSync(dst, next);
        changed = true;
      }
      files += 1;
    }
  }
  return { files, changed };
}

/**
 * 在 profile 的 package.json 里登记一个本地插件。
 *
 * 只做增补：已有的 dependencies 条目（包括用户自己换过来源的）保持原样，
 * 只有缺的时候才补上。返回是否真的改动了文件。
 * @param {string} profileDir profile 目录
 * @param {{ name: string, spec: string }} plugin 包名与依赖说明（file: 相对路径）
 * @returns {{ changed: boolean, addedDependency: boolean, addedBundle: boolean }}
 */
function registerInManifest(profileDir, plugin) {
  const file = path.join(profileDir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { changed: false, addedDependency: false, addedBundle: false, error: 'profile package.json 读不到' };
  }
  if (manifest === null || typeof manifest !== 'object') {
    return { changed: false, addedDependency: false, addedBundle: false, error: 'profile package.json 不是对象' };
  }
  let addedDependency = false;
  let addedBundle = false;

  if (manifest.dependencies === undefined || manifest.dependencies === null || typeof manifest.dependencies !== 'object') {
    manifest.dependencies = {};
  }
  if (typeof manifest.dependencies[plugin.name] !== 'string') {
    manifest.dependencies[plugin.name] = plugin.spec;
    addedDependency = true;
  }

  if (manifest.dsh === undefined || manifest.dsh === null || typeof manifest.dsh !== 'object') manifest.dsh = {};
  if (manifest.dsh.profile === undefined || manifest.dsh.profile === null || typeof manifest.dsh.profile !== 'object') manifest.dsh.profile = {};
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = [];
  if (!manifest.dsh.profile.bundles.includes(plugin.name)) {
    manifest.dsh.profile.bundles.push(plugin.name);
    addedBundle = true;
  }

  const changed = addedDependency || addedBundle;
  if (changed) fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { changed, addedDependency, addedBundle };
}

/**
 * profile 的 node_modules 里是否真的能解析到这个插件。
 * @param {string} profileDir profile 目录
 * @param {string} name 包名
 * @returns {boolean}
 */
function resolvable(profileDir, name) {
  try {
    return fs.existsSync(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json'));
  } catch {
    return false;
  }
}

function installedBundle(dshBin, name) {
  const requireFromDsh = createRequire(path.resolve(dshBin));
  return (requireFromDsh.resolve.paths(name) || []).some((directory) =>
    fs.existsSync(path.join(directory, name, 'package.json')));
}

/**
 * 用 dsh 自己的插件命令在 profile 里跑一次 pnpm install。
 * @param {object} options
 * @param {string} options.dshBin dsh CLI 入口（lib/bin.js）
 * @param {string} options.profile profile 名
 * @param {string} options.home DSH_HOME
 * @param {NodeJS.ProcessEnv} options.env 子进程环境
 * @returns {{ ok: boolean, output: string }}
 */
function installProfile({ dshBin, profile, home, env }) {
  const result = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', profile, 'install'], {
    cwd: path.dirname(dshBin),
    env: { ...env, DSH_HOME: home, CI: 'true' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { ok: result.status === 0, output };
}

/**
 * 确保随包插件都在给定 profile 里。
 *
 * 谁调用：DSH web 拉起之前（core/agent/dsh-web-client.js 的 spawnDshWeb）。
 * 什么时候什么都不做：profile 还没生成、或已经登记且能解析。
 * @param {object} options
 * @param {string} options.home DSH_HOME
 * @param {string} options.contentRoot content 根目录（打包版是 resources/content）
 * @param {string} options.dshBin dsh CLI 入口
 * @param {string} [options.profile] profile 名，默认 web
 * @param {NodeJS.ProcessEnv} [options.env] 子进程环境
 * @param {(level: string, message: string) => void} [options.log] 日志回调
 * @returns {{ ok: boolean, applied: string[], skipped: string[], errors: string[] }}
 */
function ensureBundledPlugins({ home, contentRoot, dshBin, profile = 'web', env = process.env, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const applied = [];
  const skipped = [];
  const errors = [];
  if (!home || !contentRoot || !dshBin) {
    return { ok: false, applied, skipped, errors: ['缺少 DSH_HOME / content 根目录 / dsh 入口，跳过随包插件'] };
  }

  // 先修内置 DSH 的依赖声明：让随包市场包进入 DSH 的「安装作用域」。
  // 这一步不依赖 profile 是否已经生成，所以放在最前面。
  const installation = ensureInstallationDependencies({ dshBin });
  if (installation.changed) {
    applied.push(`内置 DSH 已认领 ${installation.added.join('、')}（否则 profile 登记的市场包解析不到）`);
  }
  if (installation.error) errors.push(`内置 DSH 依赖修补：${installation.error}`);

  const profileDir = path.join(home, 'profiles', profile);
  if (!fs.existsSync(path.join(profileDir, 'package.json'))) {
    // 全新安装：profile 由 DSH 自己首次启动时生成，下一次启动再登记。
    // 但安装作用域的修补已经在上面做完了，这里也要把日志打出去，否则
    // 「首启静默修好」在日志里看不出来，排查时会以为根本没跑。
    for (const line of applied) say('info', `随包插件：${line}`);
    for (const line of errors) say('warn', `随包插件：${line}`);
    skipped.push('profile 尚未生成');
    return { ok: true, applied, skipped, errors };
  }

  let needInstall = false;
  for (const dependency of REQUIRED_PROFILE_PACKAGES) {
    const registered = registerInManifest(profileDir, dependency);
    if (registered.error) {
      errors.push(`${dependency.name}: ${registered.error}`);
      continue;
    }
    if (registered.changed) {
      applied.push(`${dependency.name}: 已登记到 profile（${[
        registered.addedDependency ? '依赖' : '',
        registered.addedBundle ? 'bundle' : ''
      ].filter(Boolean).join(' + ')}）`);
    }
    if (!installedBundle(dshBin, dependency.name) && !resolvable(profileDir, dependency.name)) needInstall = true;
  }

  for (const plugin of BUNDLED_PROFILE_PLUGINS) {
    const source = path.join(contentRoot, plugin.sourceDir);
    if (!fs.existsSync(path.join(source, 'package.json'))) {
      errors.push(`${plugin.name}: 随包目录缺失（${source}）`);
      continue;
    }
    const targetDir = path.join(profileDir, PROFILE_PLUGINS_DIR, plugin.name);
    let copied;
    try {
      copied = copyTree(source, targetDir);
    } catch (error) {
      errors.push(`${plugin.name}: 复制失败（${String((error && error.message) || error)}）`);
      continue;
    }
    if (copied.changed) applied.push(`${plugin.name}: 已同步到 profile（${copied.files} 个文件）`);

    const registered = registerInManifest(profileDir, {
      name: plugin.name,
      spec: `file:./${PROFILE_PLUGINS_DIR}/${plugin.name}`
    });
    if (registered.error) {
      errors.push(`${plugin.name}: ${registered.error}`);
      continue;
    }
    if (registered.changed) applied.push(`${plugin.name}: 已登记进 profile（${[
      registered.addedDependency ? '依赖' : '',
      registered.addedBundle ? 'bundle' : ''
    ].filter(Boolean).join(' + ')}）`);
    // 内容变了也要走一次 install：pnpm 的链接/记录以这次安装为准。
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    if (manifest.dependencies[plugin.name] === `file:./${PROFILE_PLUGINS_DIR}/${plugin.name}`) {
      const moduleDir = path.join(profileDir, 'node_modules', plugin.name);
      copyTree(targetDir, moduleDir);
    } else if (registered.addedDependency || registered.addedBundle || !resolvable(profileDir, plugin.name)) {
      needInstall = true;
    } else {
      skipped.push(`${plugin.name}: 已就绪`);
    }
  }

  if (needInstall) {
    const result = installProfile({ dshBin, profile, home, env });
    if (result.ok) {
      applied.push('pnpm install 完成');
    } else {
      errors.push(`dsh plugin install 失败${result.output ? `：${result.output.split(/\r?\n/).slice(-6).join(' / ')}` : ''}`);
    }
  }

  for (const line of applied) say('info', `随包插件：${line}`);
  for (const line of errors) say('warn', `随包插件：${line}`);
  return { ok: errors.length === 0, applied, skipped, errors };
}

module.exports = {
  BUNDLED_PROFILE_PLUGINS,
  REQUIRED_PROFILE_PACKAGES,
  ensureBundledPlugins,
  ensureInstallationDependencies,
  registerInManifest,
  copyTree
};
