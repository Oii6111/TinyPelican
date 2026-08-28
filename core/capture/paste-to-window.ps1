# 小鹈鹕 — 把建议文本安全回填到微信输入框
# 流程：写剪贴板 -> 校验句柄/进程 -> 恢复最小化窗口 -> SetForegroundWindow -> 二次确认前台窗口 -> Ctrl+V（绝不发送 Enter）。
# 任何一步校验失败都只保留剪贴板内容，不发送按键。
param(
    [long]$Handle = 0,
    [int]$TargetPid = 0,
    [string]$TargetProcessName = '',
    [string]$TextB64 = ''
)

$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class XTHPaste {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

# 1. 先把建议文本写入剪贴板：后续任何校验失败，用户仍可手动粘贴。
$bytes = [Convert]::FromBase64String($TextB64)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
Set-Clipboard -Value $text -ErrorAction Stop

if ($Handle -le 0) {
    Write-Output 'NO_WINDOW'
    exit 2
}

$h = [IntPtr]$Handle
if (-not [XTHPaste]::IsWindow($h)) {
    Write-Output 'NO_WINDOW'
    exit 2
}

# 2. 句柄仍有效，再确认窗口仍属于捕获时记录的进程。
if ($TargetPid -gt 0) {
    $winPid = [uint32]0
    [void][XTHPaste]::GetWindowThreadProcessId($h, [ref]$winPid)
    if ([int]$winPid -ne $TargetPid) {
        Write-Output 'WINDOW_CHANGED'
        exit 3
    }
    if ($TargetProcessName) {
        try {
            $proc = Get-Process -Id $TargetPid -ErrorAction Stop
            if ($proc.ProcessName -ne $TargetProcessName) {
                Write-Output 'WINDOW_CHANGED'
                exit 3
            }
        } catch {
            Write-Output 'WINDOW_CHANGED'
            exit 3
        }
    }
}

# 3. 最小化则先恢复。
if ([XTHPaste]::IsIconic($h)) {
    [void][XTHPaste]::ShowWindow($h, 9)  # SW_RESTORE
    Start-Sleep -Milliseconds 150
}

# 4. 尝试把微信窗口带到前台。
[void][XTHPaste]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 150

# 5. 二次确认：前台窗口必须还是目标句柄，否则绝不发送 Ctrl+V。
$fg = [XTHPaste]::GetForegroundWindow()
if ($fg -ne $h) {
    Write-Output 'FOREGROUND_BLOCKED'
    exit 4
}

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^v')
Write-Output 'PASTED'
exit 0
