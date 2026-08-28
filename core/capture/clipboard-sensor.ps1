# 小鹈鹕 — 剪贴板传感器（常驻轻量进程）
# 检测到剪贴板变化时输出：CHANGE <windowHandle> <pid> <processName> <b64>
# 句柄/进程信息用于回填前校验，避免粘贴到错误窗口。
param([int]$PollMs = 700)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XTHClipboard {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    public static uint GetForegroundPid() {
        uint pid = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
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
        $procId = [XTHClipboard]::GetForegroundPid()
        $pname = ''
        if ($procId -gt 0) {
            try { $pname = (Get-Process -Id $procId).ProcessName } catch {}
        }
        if (-not $pname) { $pname = '' }
        Write-Output ("CHANGE " + $handle + " " + $procId + " " + $pname + " " + $b64)
    }
    Start-Sleep -Milliseconds $PollMs
}
