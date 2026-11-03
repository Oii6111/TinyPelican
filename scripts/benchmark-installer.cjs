'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { build, Platform, Arch } = require('../app/node_modules/electron-builder');

async function main() {
  const root = path.resolve(__dirname, '..');
  const payload = path.join(root, 'app', 'dist', 'win-unpacked');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'pelican-speed-'));
  const installed = path.join(output, 'installed');
  const executable = path.join(payload, 'PelicanSpeedTest.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), executable);
  try {
    await build({
      projectDir: path.join(root, 'app'),
      prepackaged: payload,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      config: {
        afterPack: () => {},
        appId: `com.tinypelican.speed.${path.basename(output)}`,
        productName: 'PelicanSpeedTest',
        executableName: 'PelicanSpeedTest',
        extraMetadata: { name: 'pelican-speed-test' },
        compression: 'normal',
        directories: { output },
        nsis: {
          differentialPackage: false,
          artifactName: 'speed-test.exe',
          runAfterFinish: false,
          createDesktopShortcut: false,
          createStartMenuShortcut: false,
          deleteAppDataOnUninstall: false
        }
      }
    });
    function run(file, args, label) {
      const started = Date.now();
      const result = spawnSync(file, args, { windowsHide: true, timeout: 180000, encoding: 'utf8' });
      const seconds = (Date.now() - started) / 1000;
      console.log(JSON.stringify({ label, seconds, status: result.status, error: result.error?.message }));
      assert.ifError(result.error);
      assert.equal(result.status, 0);
      assert.ok(seconds < 180, `${label} exceeds three minutes`);
    }
    const installer = path.join(output, 'speed-test.exe');
    run(installer, ['/S', `/D=${installed}`], 'fresh install');
    assert.ok(fs.existsSync(path.join(installed, 'resources', 'content', 'vendor', 'node_modules', 'dshmarket', 'package.json')));
    run(installer, ['/S', `/D=${installed}`], 'overwrite install');
    run(path.join(installed, 'Uninstall PelicanSpeedTest.exe'), ['/S', '--updated', '/currentuser', `_?=${installed}`], 'cleanup');
    console.log(`Benchmark artifacts: ${output}`);
  } finally {
    if (fs.existsSync(executable)) fs.unlinkSync(executable);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
