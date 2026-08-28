# 小鹈鹕 — 把建议文本回填到目标窗口输入框
# 恢复窗口 -> 写入剪贴板 -> Ctrl+V；不发送 Enter。
param(
    [long]$Handle = 0,
    [string]$TextB64 = ''
)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XTHWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
"@

$bytes = [Convert]::FromBase64String($TextB64)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
Set-Clipboard -Value $text -ErrorAction Stop

if ($Handle -le 0) {
    Write-Output 'NO_WINDOW'
    exit 2
}

$h = [IntPtr]$Handle
if (-not [XTHWindow]::IsWindow($h)) {
    Write-Output 'NO_WINDOW'
    exit 2
}

[void][XTHWindow]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 150
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
Write-Output 'PASTED'
exit 0
