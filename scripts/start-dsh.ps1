# 小鹈鹕 — 手工启动内置 DSH（排障用）
#
# 什么时候用它：微信/看板发起对话报 "fetch failed"、浏览器打开 http://127.0.0.1:3080 没反应，
# 说明 DSH 后端没起来。运行本脚本会在**前台**启动安装包内置的 DSH，
# 并把启动日志/报错打印在窗口里，同时追加到 <用户数据目录>\dsh.log 与 activity.log。
#
# 安装包里的入口是同目录的 start-dsh.cmd（ASCII 壳，双击即可）。
# 本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 会按 ANSI 解码中文并解析失败）。

$ErrorActionPreference = 'Continue'

# content 目录 = 本脚本所在目录（打包后为 resources\content）
$content = $PSScriptRoot
$appDir = (Resolve-Path (Join-Path $content '..\..')).Path

$exe = Get-ChildItem -LiteralPath $appDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch 'Uninstall' } |
  Sort-Object Length -Descending |
  Select-Object -First 1
if (-not $exe) {
  Write-Host "[x] 没找到小鹈鹕主程序：$appDir" -ForegroundColor Red
  exit 1
}

$dshBin = Join-Path $content 'vendor\node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $dshBin)) {
  Write-Host "[x] 安装目录里没有内置 DSH：$dshBin" -ForegroundColor Red
  Write-Host '    （安装包可能被安全软件清理过，建议重装一次）'
  exit 1
}

$dataDir = Join-Path $env:APPDATA 'xiaotihu'
$dshHome = Join-Path $dataDir 'dsh-home'
New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
$logFile = Join-Path $dataDir 'dsh.log'

Write-Host '小鹈鹕：手工启动内置 DSH'
Write-Host ("  主程序   = {0}" -f $exe.FullName)
Write-Host ("  内置 DSH = {0}" -f $dshBin)
Write-Host ("  DSH_HOME = {0}" -f $dshHome)
Write-Host ("  日志     = {0}" -f $logFile)
Write-Host '  （首次启动会在 DSH_HOME 下生成 profile，可能要几十秒；成功后浏览器访问 http://127.0.0.1:3080）'
Write-Host ''

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $dshHome

try {
  # 用安装包自带的 Electron 当 Node 跑 DSH；-NoNewWindow 让它的输出直接显示在这里
  & $exe.FullName $dshBin web --port 3080 --no-open 2>&1 | Tee-Object -FilePath $logFile -Append
} catch {
  Write-Host ("[x] 启动 DSH 失败：" + $_.Exception.Message) -ForegroundColor Red
}

Write-Host ''
Write-Host ("[DSH 已退出] 上面的输出就是原因，也可把 {0} 发给开发者。" -f $logFile) -ForegroundColor Yellow
