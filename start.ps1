# 小鹈鹕 — 一键启动（开发模式）
# 后台拉起 core/launcher.js（守护核心：HTTP 服务 + 剪贴板监听 + 微信通道 + 定时任务），然后打开本地窗口。
# 用法：双击「启动小鹈鹕.bat」，或 powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1
# 注意：本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会按 ANSI 解码中文注释并解析失败。

$ErrorActionPreference = 'Stop'
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

function Wait-Core([int]$port, [string]$root, [int]$timeoutSec = 90) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    $url = "http://127.0.0.1:$port/api/health"
    do {
        try {
            $health = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 2
            if ($health.ok -and $health.name -eq 'xiaotihu-core') {
                $expected = [IO.Path]::GetFullPath($root).TrimEnd('').ToLowerInvariant()
                $actual = [IO.Path]::GetFullPath([string]$health.projectRoot).TrimEnd('').ToLowerInvariant()
                if ($expected -ne $actual) { throw "端口 $port 已被其他目录的小鹈鹕占用（$($health.projectRoot)）。" }
                return $true
            }
        } catch {
            if ($_.Exception.Message -like '端口 *已被其他目录*') { throw }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "核心服务在 $timeoutSec 秒内没有就绪，请检查数据目录中的 activity.log。"
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'node' }

Write-Host "[启动] 检查核心服务..."
if (Test-Port $WebPort) {
    Write-Host "[启动] 核心服务已在线"
} else {
    Write-Host "[启动] 启动核心服务（后台）..."
    $process = Start-Process -FilePath $node -ArgumentList @($Core) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    try { Wait-Core $WebPort $Root } catch {
        if ($process.HasExited) { throw "核心进程已退出（$($process.ExitCode)）。$($_.Exception.Message)" }
        throw
    }
}

$url = "http://127.0.0.1:$WebPort"
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (Test-Path $edge) {
    Start-Process -FilePath $edge -ArgumentList ('--app=' + $url)
} else {
    Start-Process $url
}
Write-Host "[启动] 完成，窗口已打开：$url"
