# 小鹈鹕 — 一键启动
# 后台拉起 gateway + 剪贴板监听器 + webui，然后打开本地窗口。
# 用法：双击「启动小鹈鹕.bat」，或 powershell -NoProfile -ExecutionPolicy Bypass -File start.ps1

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$Watcher = Join-Path $Root 'watch-clipboard.ps1'
$Server = Join-Path $Root 'dashboard\server.mjs'
$WebPort = 18791
$GwPort = 18789

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

# 1) gateway
Write-Host "[启动] 检查 gateway..."
if (Test-Port $GwPort) {
    Write-Host "[启动] gateway 已在线"
} else {
    Write-Host "[启动] 启动 gateway（后台，首次约 5-10 秒）..."
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','openclaw gateway run' -WindowStyle Hidden
    Start-Sleep -Seconds 8
}

# 2) webui
Write-Host "[启动] 检查 webui..."
if (Test-Port $WebPort) {
    Write-Host "[启动] webui 已在线"
} else {
    Write-Host "[启动] 启动 webui（后台）..."
    Start-Process -FilePath $node -ArgumentList $Server -WorkingDirectory (Split-Path $Server) -WindowStyle Hidden
    Start-Sleep -Seconds 2
}

# 3) 监听器
Write-Host "[启动] 检查监听器..."
$watcherProc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'watch-clipboard\.ps1' }
if ($watcherProc) {
    Write-Host "[启动] 监听器已在运行"
} else {
    Write-Host "[启动] 启动监听器（后台）..."
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File', $Watcher -WindowStyle Minimized
    Start-Sleep -Seconds 1
}

# 4) 打开窗口
$url = "http://127.0.0.1:$WebPort"
$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (Test-Path $edge) {
    Start-Process -FilePath $edge -ArgumentList ('--app=' + $url)
} else {
    Start-Process $url
}
Write-Host "[启动] 完成，窗口已打开：$url"
