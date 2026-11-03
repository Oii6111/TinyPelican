// 打包后安装包的端到端验证（真实安装器，不是 QA 夹具）
//
// 复现并验证 docs/windows-installer.md 里记录的故障形态：
//   A. 干净安装
//   B. 核心进程（resources\content\runtime\node.exe）仍在跑时覆盖安装
//      —— 这是用户报的「提示小鹈鹕正在运行，无法关闭」的主因：外壳只是 Electron 壳，
//         真正占着 resources\content 的是随包的 node.exe
//   C. 外壳进程（小鹈鹕.exe）在跑时覆盖安装
//      —— app/main.js 的 win.on('close') 是 preventDefault + hide()，关窗只是收到托盘，
//         所以 NSIS 的 CloseProcess(WM_CLOSE) 根本关不掉它
//   D. 陈旧安装记录（卸载器还在、安装目录里的程序 exe 已丢）
//   E. 卸载：目录消失、进程不再残留
//
// 用法：node scripts/e2e-installer.cjs [installer.exe]
// 注意：会写入 HKCU 卸载注册表项；卸载测试前后会搬走/还原 %APPDATA%\xiaotihu，
//       避免把开发机的真实用户数据一起删掉。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PRODUCT = '小鹈鹕';
const EXE = `${PRODUCT}.exe`;
const UNINSTALLER = `Uninstall ${PRODUCT}.exe`;
const BASE = path.join(ROOT, 'tmp', 'e2e');
const INSTALL_DIR = path.join(BASE, 'installed');
const APPDATA = process.env.APPDATA;
const USER_DATA = path.join(APPDATA, 'xiaotihu');
const USER_DATA_BACKUP = path.join(APPDATA, 'xiaotihu.e2e-backup');

let step = 0;
function log(message) {
  step += 1;
  console.log(`[${String(step).padStart(2, '0')}] ${message}`);
}
function fail(message) {
  throw new Error(message);
}
function check(condition, message) {
  if (!condition) fail(message);
}

function newestInstaller() {
  const dir = path.join(ROOT, 'app', 'dist');
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^TinyPelican-Setup-.*\.exe$/.test(name))
    .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (!files.length) fail('app/dist 下没有 TinyPelican-Setup-*.exe');
  return path.join(dir, files[0].name);
}

function run(file, args, label, timeout = 20 * 60 * 1000) {
  const started = Date.now();
  const result = spawnSync(file, args, { windowsHide: true, timeout, encoding: 'utf8' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) fail(`${label} 无法执行：${result.error.message}`);
  console.log(`     ${label}: 退出码=${result.status} 用时=${seconds}s`);
  return result;
}

function install(installer, label) {
  // NSIS：/S 静默；/D= 必须是最后一个参数且不能加引号
  const result = run(installer, ['/S', `/D=${INSTALL_DIR}`], label);
  check(result.status === 0, `${label} 失败：退出码 ${result.status}（2 通常就是「应用无法关闭」）`);
}

function assertInstalled() {
  check(fs.existsSync(path.join(INSTALL_DIR, EXE)), `安装目录缺少 ${EXE}`);
  const core = path.join(INSTALL_DIR, 'resources', 'content', 'runtime', 'node.exe');
  check(fs.existsSync(core), '安装目录缺少 resources\\content\\runtime\\node.exe');
  return core;
}

// 启动一个「驻留」进程，用来模拟占着安装目录文件的残留进程。
// 注意：这里刻意不监听 'exit' 事件 —— 子进程会被安装器从外部强杀，
// 在 Windows 上回溯该事件容易让 Node 走到异常退出路径（0xC0000409）。
// 存活判断改为 PID 轮询，跟进程实际状态一致。
function spawnResident(file, label) {
  const child = spawn(file, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
    // 让子进程脱离父进程的事件循环：它随后会被安装器从外部强杀，
    // 若仍挂在 libuv 里，Node 收尾阶段容易异常终止（0xC0000409）
    detached: true
  });
  child.unref();
  // 只记录，不抛异常：'error' 事件里抛错会直接终止进程
  child.once('error', (error) => console.error(`${label} 启动失败：${error.message}`));
  return { child, label, pid: child.pid };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    // 只用内核查询，不派生子进程（派生物料在 400+ 进程的机器上又慢又易受干扰）
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但没权限，仍然算存活
    return error.code === 'EPERM';
  }
}

async function waitDead(resident, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(resident.pid)) {
      console.log(`     ${resident.label}（pid ${resident.pid}）已退出`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail(`${resident.label}（pid ${resident.pid}）仍然存活：进程树没有被清理`);
}

function killResident(resident) {
  try {
    resident.child.kill();
  } catch {}
  if (pidAlive(resident.pid)) {
    spawnSync('taskkill', ['/PID', String(resident.pid), '/F'], { windowsHide: true, stdio: 'ignore' });
  }
}

function removeInstallDir() {
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
}

function backupUserData() {
  if (!fs.existsSync(USER_DATA)) return false;
  fs.rmSync(USER_DATA_BACKUP, { recursive: true, force: true });
  fs.renameSync(USER_DATA, USER_DATA_BACKUP);
  return true;
}

function restoreUserData(had) {
  if (!had) return;
  if (fs.existsSync(USER_DATA)) fs.rmSync(USER_DATA, { recursive: true, force: true });
  if (fs.existsSync(USER_DATA_BACKUP)) fs.renameSync(USER_DATA_BACKUP, USER_DATA);
}

async function main() {
  const installer = process.argv[2] ? path.resolve(process.argv[2]) : newestInstaller();
  check(fs.existsSync(installer), `安装包不存在：${installer}`);
  const sizeMb = (fs.statSync(installer).size / 1024 / 1024).toFixed(1);
  log(`安装包：${installer}（${sizeMb} MB）`);

  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });
  let userDataMoved = false;
  const residents = [];

  try {
    // A. 干净安装
    install(installer, 'A 干净安装');
    const core = assertInstalled();
    check(fs.statSync(path.join(INSTALL_DIR, EXE)).size > 100 * 1024 * 1024, `${EXE} 体积异常，可能不是真正的 Electron 外壳`);
    log('A 通过：安装目录完整');

    // B. 核心进程在跑时覆盖安装（用户报的主因）
    const coreResident = spawnResident(core, '模拟核心进程 node.exe');
    residents.push(coreResident);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check(pidAlive(coreResident.pid), '模拟核心进程没能启动');
    install(installer, 'B 核心运行时覆盖安装');
    await waitDead(coreResident, 30000);
    assertInstalled();
    log('B 通过：核心进程被清理，覆盖安装成功');

    // C. 外壳进程在跑时覆盖安装
    const shellCopy = path.join(INSTALL_DIR, EXE);
    fs.copyFileSync(core, shellCopy);
    const shellResident = spawnResident(shellCopy, `模拟外壳进程 ${EXE}`);
    residents.push(shellResident);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check(pidAlive(shellResident.pid), '模拟外壳进程没能启动');
    install(installer, 'C 外壳运行时覆盖安装');
    await waitDead(shellResident, 30000);
    check(fs.statSync(shellCopy).size > 100 * 1024 * 1024, '覆盖安装后外壳没有被还原成真正的 Electron 程序');
    assertInstalled();
    log('C 通过：外壳进程被清理，装回了真正的应用');

    // D. 陈旧记录：卸载器还在，但程序 exe 已经没了
    for (const entry of fs.readdirSync(INSTALL_DIR)) {
      if (entry === UNINSTALLER) continue;
      fs.rmSync(path.join(INSTALL_DIR, entry), { recursive: true, force: true });
    }
    check(!fs.existsSync(path.join(INSTALL_DIR, EXE)), '清场失败：程序 exe 应当已被删除');
    install(installer, 'D 陈旧记录覆盖安装');
    assertInstalled();
    log('D 通过：陈旧安装记录没有阻塞安装');

    // E. 卸载
    userDataMoved = backupUserData();
    if (userDataMoved) log('已暂存 %APPDATA%\\xiaotihu（卸载会删它，测完还原）');
    const uninstallerPath = path.join(INSTALL_DIR, UNINSTALLER);
    check(fs.existsSync(uninstallerPath), `安装目录里没有 ${UNINSTALLER}`);
    // NSIS 卸载器会把自身复制到临时目录再执行，这里同样先复制，避免自锁
    const uninstallerCopy = path.join(BASE, UNINSTALLER);
    fs.copyFileSync(uninstallerPath, uninstallerCopy);
    const un = run(uninstallerCopy, ['/S', '/currentuser', `_?=${INSTALL_DIR}`], 'E 卸载');
    check(un.status === 0, `卸载失败：退出码 ${un.status}`);
    check(!fs.existsSync(INSTALL_DIR), '卸载后安装目录仍然存在');
    log('E 通过：卸载干净');

    console.log('\n全部通过：A(干净安装) B(核心进程) C(外壳进程) D(陈旧记录) E(卸载)');
  } finally {
    for (const resident of residents) killResident(resident);
    restoreUserData(userDataMoved);
    if (fs.existsSync(INSTALL_DIR)) {
      for (const entry of fs.readdirSync(INSTALL_DIR)) {
        if (entry.startsWith('Uninstall ')) {
          fs.rmSync(path.join(INSTALL_DIR, entry), { force: true });
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(`\n失败：${error.message}`);
  process.exitCode = 1;
});
