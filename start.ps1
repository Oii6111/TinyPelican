# 小鹈鹕 — 一键启动（开发模式）
# 后台拉起 core/launcher.js（守护核心：HTTP 服务 + 剪贴板监听 + 微信通道 + 定时任务），然后打开本地窗口。
# 用法：双击「启动小鹈鹕.bat」，或 powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$Core = Join-Path $Root 'core\launcher.js'
$WebPort = 18791

function Test-Port([int]$port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ar = $c.BeginConnect('127.0.0.1', $port, $null, $null)
        if ($ar.AsyncWaitHandle.WaitOne(600)) { $c.EndConnect($ar); $c.Close(); return $true }
        $c.Close(); return $false
    } catch { return $false }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node' }

Write-Host "[启动] 检查核心服务..."
if (Test-Port $WebPort) {
    Write-Host "[启动] 核心服务已在线"
} else {
    Write-Host "[启动] 启动核心服务（后台）..."
    Start-Process -FilePath $node -ArgumentList $Core -WorkingDirectory $Root -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

$url = "http://127.0.0.1:$WebPort"
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (Test-Path $edge) {
    Start-Process -FilePath $edge -ArgumentList ('--app=' + $url)
} else {
    Start-Process $url
}
Write-Host "[启动] 完成，窗口已打开：$url"
