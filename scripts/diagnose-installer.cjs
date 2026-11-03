const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { build, Platform, Arch } = require('../app/node_modules/electron-builder');

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-diagnosis-'));
  const fixture = path.join(directory, 'fixture');
  const installed = path.join(directory, 'installed');
  fs.mkdirSync(path.join(fixture, 'resources'), { recursive: true });
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), path.join(fixture, 'PelicanDiagnostic.exe'));
  fs.writeFileSync(path.join(fixture, 'marker.txt'), 'diagnostic fixture');
  let include = fs.readFileSync(path.join(root, 'scripts', 'installer-cleanup.nsh'), 'utf8');
  assert.ok(!include.includes('!define APP_BUILD_DIR'), 'Production include must not replace the packaged fixture');
  include = include.replaceAll('$APPDATA', path.join(directory, 'appdata'));
  fs.writeFileSync(path.join(directory, 'include.nsh'), include);
  fs.copyFileSync(path.join(root, 'scripts', 'installer-extract.nsh'), path.join(directory, 'installer-extract.nsh'));
  console.log(`Artifacts: ${directory}`);
  await build({
    projectDir: path.join(root, 'app'),
    prepackaged: fixture,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    config: {
      afterPack: () => {},
      appId: `com.xiaotihu.diagnostic.${path.basename(directory)}`,
      productName: 'PelicanDiagnostic',
      executableName: 'PelicanDiagnostic',
      extraMetadata: { name: 'pelican-installer-diagnostic' },
      compression: 'store',
      directories: { output: directory },
      nsis: {
        include: path.join(directory, 'include.nsh'),
        artifactName: 'diagnostic.exe',
        runAfterFinish: false,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        deleteAppDataOnUninstall: false
      }
    }
  });
  function run(file, args) {
    const started = Date.now();
    const result = spawnSync(file, args, { timeout: 30000, windowsHide: true, encoding: 'utf8' });
    console.log(JSON.stringify({ file, args, status: result.status, error: result.error?.message, seconds: (Date.now() - started) / 1000 }));
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'Installer/uninstaller must exit successfully');
    return result;
  }
  const installer = path.join(directory, 'diagnostic.exe');
  const userData = path.join(directory, 'appdata', 'xiaotihu', 'keep.txt');
  fs.mkdirSync(path.dirname(userData), { recursive: true });
  fs.writeFileSync(userData, 'preserve user data');
  run(installer, ['/S', `/D=${installed}`]);
  console.log('Installed:', fs.readdirSync(installed));
  run(installer, ['/S', `/D=${installed}`]);
  const uninstaller = path.join(installed, 'Uninstall PelicanDiagnostic.exe');
  assert.ok(fs.existsSync(uninstaller), 'Installer must produce an uninstaller');
  if (fs.existsSync(uninstaller)) {
    run(uninstaller, ['/S', '--updated', '/currentuser', `_?=${installed}`]);
    console.log('Remaining:', fs.existsSync(installed) ? fs.readdirSync(installed) : []);
    assert.ok(!fs.existsSync(path.join(installed, 'marker.txt')), 'Uninstaller must remove application files');
    assert.equal(fs.readFileSync(userData, 'utf8'), 'preserve user data');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
