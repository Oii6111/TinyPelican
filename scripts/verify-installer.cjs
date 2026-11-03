const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { build, Platform, Arch } = require('../app/node_modules/electron-builder');

const root = path.resolve(__dirname, '..');
const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tinypelican-uninstall-qa-'));
const fixture = path.join(qaRoot, 'fixture');
const installed = path.join(qaRoot, 'installed');
const appData = path.join(qaRoot, 'app-data');
const product = '小鹈鹕卸载验证';
const executable = `${product}.exe`;

function run(file, args) {
  const result = spawnSync(file, args, { windowsHide: true, timeout: 60000, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${file}: ${result.stderr || result.stdout}`);
}

async function main() {
  fs.mkdirSync(path.join(fixture, 'resources'), { recursive: true });
  fs.copyFileSync(process.execPath, path.join(fixture, executable));
  fs.writeFileSync(path.join(fixture, 'marker.txt'), 'isolated uninstall fixture');
  const include = path.join(qaRoot, 'qa.nsh');
  const productionInclude = fs.readFileSync(path.join(root, 'scripts', 'installer-cleanup.nsh'), 'utf8');
  const guard = `!macro customUnInstall\nStrCmp $INSTDIR "${installed}" safe_uninstall\nAbort "Unexpected uninstall directory"\nsafe_uninstall:\n`;
  assert.match(productionInclude, /!macro customUnInstall\r?\n/);
  fs.writeFileSync(include, productionInclude.replace(/!macro customUnInstall\r?\n/, guard).replaceAll('$APPDATA', appData));
  fs.copyFileSync(path.join(root, 'scripts', 'installer-extract.nsh'), path.join(qaRoot, 'installer-extract.nsh'));
  await build({
    projectDir: path.join(root, 'app'),
    prepackaged: fixture,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      afterPack: () => {},
      appId: 'com.xiaotihu.uninstall-qa',
      productName: product,
      executableName: product,
      extraMetadata: { name: 'tinypelican-uninstall-qa' },
      compression: 'store',
      directories: { output: qaRoot },
      nsis: {
        include,
        artifactName: 'uninstall-qa-setup.exe',
        runAfterFinish: false,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        deleteAppDataOnUninstall: false,
      },
    },
  });
  const installer = path.join(qaRoot, 'uninstall-qa-setup.exe');
  for (const { running, updated } of [{ running: false, updated: true }, { running: true, updated: true }, { running: false, updated: false }]) {
    for (const name of ['TinyPelican', 'xiaotihu']) {
      fs.mkdirSync(path.join(appData, name), { recursive: true });
      fs.writeFileSync(path.join(appData, name, 'marker.txt'), 'preserve on upgrade');
    }
    run(installer, ['/S', `/D=${installed}`]);
    assert.ok(fs.existsSync(path.join(installed, 'marker.txt')));
    let child;
    try {
      if (running) {
        child = spawn(path.join(installed, executable), ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', resolve);
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const uninstaller = fs.readdirSync(installed).find(name => /^Uninstall .*\.exe$/.test(name));
      assert.ok(uninstaller);
      const copy = path.join(qaRoot, `uninstall-${running}.exe`);
      fs.copyFileSync(path.join(installed, uninstaller), copy);
      run(copy, ['/S', ...(updated ? ['--updated'] : []), '/currentuser', `_?=${installed}`]);
      assert.ok(!fs.existsSync(installed), 'Installation directory must be removed');
      for (const name of ['TinyPelican', 'xiaotihu']) {
        assert.equal(fs.readFileSync(path.join(appData, name, 'marker.txt'), 'utf8'), 'preserve on upgrade', 'Preserve user data during both upgrade and normal uninstall');
      }
      if (child) {
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.notEqual(child.exitCode, null, 'Running application must exit');
      }
      console.log(`PASS: ${updated ? 'upgrade' : 'normal'} uninstall with application ${running ? 'running' : 'absent'}; data preserved`);
    } finally {
      if (child && child.exitCode === null) child.kill();
    }
  }
  console.log(`QA artifacts: ${qaRoot}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
