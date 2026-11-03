// 安装器 NSIS 宏自检（scripts/installer-cleanup.nsh）
//
// 背景：打包版的外壳是 小鹈鹕.exe，但真正跑业务的核心是随包的 content\runtime\node.exe
// （见 core/lib/runtime-node.js），核心下面还挂着 DSH 与各种工具进程。只按外壳镜像名去
// 判断/关闭进程，必然出现「提示应用正在运行、无法关闭」，用户看到的就是安装失败。
//
// 这里只做静态校验（不跑 electron-builder：约 370MB 的产物，不适合进单测）：
//  1. customCheckAppRunning 必须同时覆盖外壳与安装目录内的其他进程，并保留上游语义；
//  2. 卸载时也要清残留进程；
//  3. nsExec 命令行里不能有非 ASCII —— NSIS 脚本是 UTF-8，而 powershell.exe -C 在中文
//     系统上按 ANSI 代码页解码命令行，中文会变成乱码导致命令直接失败。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NSC = fs.readFileSync(path.join(ROOT, 'scripts', 'installer-cleanup.nsh'), 'utf8');

function macroBody(name) {
  const start = NSC.indexOf(`!macro ${name}`);
  assert.ok(start >= 0, `installer-cleanup.nsh 缺少 !macro ${name}`);
  const end = NSC.indexOf('!macroend', start);
  assert.ok(end > start, `!macro ${name} 没有闭合`);
  return NSC.slice(start, end);
}

test('安装器：关闭进程要覆盖安装目录里的整棵进程树', () => {
  const body = macroBody('customCheckAppRunning');
  assert.match(body, /nsProcess::FindProcess "\$\{APP_EXECUTABLE_FILENAME\}"/, '要先按外壳可执行文件名检查');
  assert.match(body, /tinyPelicanKillInstallDirProcesses/, '外壳之外还要清理安装目录内的核心/子进程');
  assert.match(body, /appCannotBeClosed/, '确实关不掉时要保留上游的报错');
  assert.match(body, /SetErrorLevel 2/, '失败要返回非 0，构建脚本与 QA 才能发现');
});

test('安装器：清理宏按 $INSTDIR 匹配进程，且命令行保持纯 ASCII', () => {
  const body = macroBody('tinyPelicanKillInstallDirProcesses');
  assert.match(body, /\$INSTDIR/, '必须按安装目录限定范围，不能误杀其他程序的 node.exe');
  assert.match(body, /Stop-Process/, '要真的结束进程');
  assert.match(body, /nsExec::Exec/, 'nsExec 才能静默执行并拿到返回码');
  for (const line of body.split(/\r?\n/)) {
    // 只校验 nsExec 那一行（注释是中文，属正常）
    if (!line.includes('nsExec::Exec')) continue;
    assert.ok(/^[\x00-\x7F]*$/.test(line), `nsExec 命令行含非 ASCII，powershell.exe -C 会乱码：${line.trim()}`);
  }
  assert.match(body, /Pop \$R1/, 'Pop 掉 nsExec 的输出，避免污染 nsProcess 读取的返回值');
});

test('安装器：卸载时结束残留核心进程但保留用户数据', () => {
  const body = macroBody('customUnInstall');
  const kill = body.indexOf('tinyPelicanKillInstallDirProcesses');
  assert.ok(kill >= 0, '卸载时要清理残留进程：否则下次重装仍报「无法关闭」');
  assert.doesNotMatch(NSC, /RMDir\s+\/r\s+"\$APPDATA/i, '卸载和升级都必须保留用户数据');
  assert.match(body, /\$\{ifNot\} \$\{isUpdated\}/, '升级时不能删用户数据');
});

test('安装器：卸载器的 $INSTDIR 由 customUnInit 恢复，不受宏顺序影响', () => {
  const body = macroBody('customUnInit');
  assert.match(
    body,
    /StrCpy \$INSTDIR \$tinyPelicanUninstallDir/,
    '卸载器的 customUnInit 必须恢复 $INSTDIR（调用方依赖它定位要清理的进程）'
  );
  const init = macroBody('customInit');
  assert.match(init, /UNINSTALL_REGISTRY_KEY/, 'customInit 负责清理陈旧安装记录');
  assert.match(init, /InstallLocation/, '旧安装目录已消失时也要清掉陈旧记录（否则旧卸载器 exit 1 → 报「无法关闭」）');
});

test('安装器：NSIS 脚本以 UTF-8 保存且带 BOM', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'scripts', 'installer-cleanup.nsh'));
  assert.deepStrictEqual(
    [...buf.subarray(0, 3)],
    [0xef, 0xbb, 0xbf],
    'installer-cleanup.nsh 含中文，需 UTF-8 with BOM，否则 makensis 按 ANSI 解码'
  );
});

test('安装器：app/package.json 引用的 NSIS include 指向本文件', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8'));
  assert.ok(pkg.build && pkg.build.nsis, 'app/package.json 缺少 build.nsis');
  assert.strictEqual(pkg.build.nsis.include, '../scripts/installer-cleanup.nsh');
  assert.strictEqual(pkg.build.nsis.deleteAppDataOnUninstall, false);
  assert.strictEqual(pkg.build.nsis.oneClick, true, '一键安装：没有「下一步」，出错只能整体中止，进程清理必须自己靠谱');
});
