'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  BUNDLED_PROFILE_PLUGINS,
  REQUIRED_PROFILE_PACKAGES,
  ensureBundledPlugins,
  registerInManifest,
  copyTree
} = require('../core/agent/dsh-bundled-plugins');

const ROOT = path.resolve(__dirname, '..');

test('packaged plugins become resolvable offline without invoking the CLI', (context) => {
  const { home, profileDir } = tempProfile();
  context.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const vendor = path.join(home, 'content', 'vendor', 'node_modules');
  const market = path.join(vendor, 'dshmarket');
  fs.mkdirSync(market, { recursive: true });
  fs.writeFileSync(path.join(market, 'package.json'), JSON.stringify({ name: 'dshmarket' }));
  const dshBin = path.join(vendor, '@deepseek-ai', 'dsh', 'lib', 'nonexistent-cli.js');
  const result = ensureBundledPlugins({ home, contentRoot: ROOT, dshBin });
  assert.strictEqual(result.ok, true, result.errors.join('\n'));
  const local = path.join(profileDir, 'node_modules', 'tinypelican-dsh-market');
  assert.ok(fs.existsSync(path.join(local, 'cordis.patch.yml')));
  assert.ok(fs.existsSync(path.join(local, 'lib', 'index.js')));
  const again = ensureBundledPlugins({ home, contentRoot: ROOT, dshBin });
  assert.strictEqual(again.ok, true, again.errors.join('\n'));
});

function tempProfile() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-bundled-'));
  const profileDir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const manifest = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { dshmarket: '^1.66.47' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'] } }
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { home, profileDir };
}

test('registerInManifest 增补依赖与 bundle，且第二次是空操作', () => {
  const { profileDir } = tempProfile();
  const plugin = { name: 'tinypelican-dsh-market', spec: 'file:./plugins/tinypelican-dsh-market' };

  const first = registerInManifest(profileDir, plugin);
  assert.deepStrictEqual(first, { changed: true, addedDependency: true, addedBundle: true });

  const second = registerInManifest(profileDir, plugin);
  assert.deepStrictEqual(second, { changed: false, addedDependency: false, addedBundle: false });

  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.strictEqual(manifest.dependencies['tinypelican-dsh-market'], plugin.spec);
  assert.strictEqual(manifest.dependencies.dshmarket, '^1.66.47', '用户已有的依赖不能被改动');
  assert.deepStrictEqual(manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dshmarket',
    'tinypelican-dsh-market'
  ]);
});

test('registerInManifest 保留用户自己换过的来源', () => {
  const { profileDir } = tempProfile();
  registerInManifest(profileDir, { name: 'tinypelican-dsh-market', spec: 'file:./plugins/tinypelican-dsh-market' });
  // 用户后来自行改了依赖（例如换成 npm 上同名包），再次自举不能覆盖它
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  manifest.dependencies['tinypelican-dsh-market'] = '^0.9.0';
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const again = registerInManifest(profileDir, { name: 'tinypelican-dsh-market', spec: 'file:./plugins/tinypelican-dsh-market' });
  assert.strictEqual(again.addedDependency, false);
  const after = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.strictEqual(after.dependencies['tinypelican-dsh-market'], '^0.9.0');
});

test('required profile packages restore a missing market dependency and bundle', () => {
  const { profileDir } = tempProfile();
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  delete manifest.dependencies.dshmarket;
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== 'dshmarket');
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const market = REQUIRED_PROFILE_PACKAGES.find((entry) => entry.name === 'dshmarket');
  assert.ok(market);
  const result = registerInManifest(profileDir, market);
  assert.deepStrictEqual(result, { changed: true, addedDependency: true, addedBundle: true });
  const restored = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  assert.strictEqual(restored.dependencies.dshmarket, '^1.66.47');
  assert.ok(restored.dsh.profile.bundles.includes('dshmarket'));
});

test('profile 尚未生成时安静跳过，不报错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-noprofile-'));
  const result = ensureBundledPlugins({ home, contentRoot: ROOT, dshBin: 'unused' });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.applied, []);
  assert.ok(result.skipped.some((line) => line.includes('profile')));
});

test('随包插件源码齐全（package.json / 补丁 / host 半 / client 半）', () => {
  assert.ok(BUNDLED_PROFILE_PLUGINS.length >= 1);
  for (const plugin of BUNDLED_PROFILE_PLUGINS) {
    const dir = path.join(ROOT, plugin.sourceDir);
    for (const rel of ['package.json', 'cordis.patch.yml', path.join('lib', 'index.js'), path.join('client', 'client.js')]) {
      assert.ok(fs.existsSync(path.join(dir, rel)), `${plugin.name} 缺少 ${rel}`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.name, plugin.name);
    assert.ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch, '必须是 DSH bundle');
    assert.strictEqual(pkg.dsh.client.platform, 'web');
    assert.ok(pkg.exports['./client'], 'client 半必须从 ./client 导出');
  }
});

test('plugin-market dialog is mounted outside the add-plugin menu lifecycle', () => {
  const source = fs.readFileSync(path.join(
    ROOT,
    'agent',
    'dsh-plugins',
    'tinypelican-market',
    'client',
    'client.js'
  ), 'utf8');
  const overlayStart = source.indexOf('function MarketOverlayHost');
  const menuStart = source.indexOf('function InstallFromMarketItem');
  const exportsStart = source.indexOf('exports.name =');
  assert.ok(overlayStart > 0 && menuStart > overlayStart && exportsStart > menuStart);
  assert.match(source, /name: 'shell\.overlay'/);
  assert.match(source.slice(overlayStart, menuStart), /h\(MarketDialog/);
  assert.doesNotMatch(source.slice(menuStart, exportsStart), /MarketDialog/);
});

test('copyTree 跳过开发期目录，只写真正变了的文件', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-src-'));
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(src, 'lib', 'index.js'), 'ok', 'utf8');
  fs.writeFileSync(path.join(src, 'src', 'ignored.ts'), 'nope', 'utf8');
  const dst = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-dst-')), 'out');

  const first = copyTree(src, dst);
  assert.deepStrictEqual(first, { files: 1, changed: true });
  assert.ok(fs.existsSync(path.join(dst, 'lib', 'index.js')));
  assert.ok(!fs.existsSync(path.join(dst, 'src')));

  const second = copyTree(src, dst);
  assert.deepStrictEqual(second, { files: 1, changed: false }, '内容没变就不该再写');

  fs.writeFileSync(path.join(src, 'lib', 'index.js'), 'changed', 'utf8');
  const third = copyTree(src, dst);
  assert.deepStrictEqual(third, { files: 1, changed: true });
  assert.strictEqual(fs.readFileSync(path.join(dst, 'lib', 'index.js'), 'utf8'), 'changed');
});
