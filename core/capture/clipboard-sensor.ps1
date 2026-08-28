# 小鹈鹕 — 剪贴板传感器（常驻轻量进程）
# 检测到剪贴板变化时，把内容以 base64 行输出到 stdout（CHANGE <windowHandle> <b64>），由 Node 侧解析。
param([int]$PollMs = 700)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XTHClipboard {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$last = ''
while ($true) {
    try {
        $clip = Get-Clipboard -Raw -ErrorAction Stop
    } catch {
        $clip = $last
    }
    if ($clip -and $clip -ne $last) {
        $last = $clip
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($clip)
        $b64 = [Convert]::ToBase64String($bytes)
        $handle = [XTHClipboard]::GetForegroundWindow().ToInt64()
        Write-Output ("CHANGE " + $handle + " " + $b64)
    }
    Start-Sleep -Milliseconds $PollMs
}
