# 小鹈鹕 — 把建议文本安全回填到微信输入框
# 流程：写剪贴板 -> 校验句柄/进程 -> 恢复最小化窗口 -> SetForegroundWindow -> 二次确认前台窗口 -> Ctrl+V（绝不发送 Enter）。
# 任何一步校验失败都只保留剪贴板内容，不发送按键。失败时输出标记（NO_WINDOW / WINDOW_CHANGED / FOREGROUND_BLOCKED / CLIPBOARD_FAILED / SENDKEYS_FAILED）供 Node 侧展示。
# 本文件必须保存为 UTF-8 with BOM：Windows PowerShell 5.1 在无 BOM 时按 ANSI 解码，中文注释会把 param 块解析坏（tests/powershell-scripts.test.js 会兜底检查）。
param(
    [long]$Handle = 0,
    [int]$TargetPid = 0,
    [string]$TargetProcessName = '',
    [string]$TextB64 = ''
)

$ErrorActionPreference = 'Stop'

try {
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
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
} catch {
    Write-Output ('INTEROP_FAILED ' + $_.Exception.Message)
    exit 1
}

# 1. 先把建议文本写入剪贴板：后续任何校验失败，用户仍可手动粘贴。
#    剪贴板可能被其它进程短暂占用（OpenClipboard 失败），重试几次再放弃。
$bytes = [Convert]::FromBase64String($TextB64)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

$copied = $false
for ($i = 0; $i -lt 5; $i++) {
    try {
        Set-Clipboard -Value $text -ErrorAction Stop
        $copied = $true
        break
    } catch {
        Start-Sleep -Milliseconds 80
    }
}
if (-not $copied) {
    Write-Output 'CLIPBOARD_FAILED'
    exit 1
}

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
$winPid = [uint32]0
$winThread = [XTHPaste]::GetWindowThreadProcessId($h, [ref]$winPid)
if ($TargetPid -gt 0) {
    if ([int]$winPid -ne $TargetPid) {
        Write-Output 'WINDOW_CHANGED'
        exit 3
    }
    if ($TargetProcessName) {
        try {
            $proc = Get-Process -Id $TargetPid -ErrorAction Stop
            # 进程名与捕获记录对齐：WeChat.exe / WeChat 都接受
            $expected = $TargetProcessName -replace '\.exe$', ''
            if ($proc.ProcessName -ne $expected) {
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
#    后台进程调用 SetForegroundWindow 常被系统拒绝，这里先 AttachThreadInput 解除前台锁，再重试几次。
$currentThread = [XTHPaste]::GetCurrentThreadId()
$attached = $false
if ($winThread -ne 0 -and $winThread -ne $currentThread) {
    $attached = [XTHPaste]::AttachThreadInput($currentThread, $winThread, $true)
}

$brought = $false
for ($i = 0; $i -lt 4; $i++) {
    [void][XTHPaste]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 120
    if ([XTHPaste]::GetForegroundWindow() -eq $h) {
        $brought = $true
        break
    }
}
if ($attached) {
    [void][XTHPaste]::AttachThreadInput($currentThread, $winThread, $false)
}

# 5. 二次确认：前台窗口必须还是目标句柄，否则绝不发送 Ctrl+V。
if (-not $brought -or [XTHPaste]::GetForegroundWindow() -ne $h) {
    Write-Output 'FOREGROUND_BLOCKED'
    exit 4
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('^v')
} catch {
    Write-Output ('SENDKEYS_FAILED ' + $_.Exception.Message)
    exit 1
}
Write-Output 'PASTED'
exit 0
