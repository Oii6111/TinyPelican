# 小鹈鹕 — 剪贴板传感器（常驻轻量进程）
# 检测到剪贴板变化时输出：
#   CHANGE <handle> <pid> <processName> <left> <top> <right> <bottom> <dpi> <b64>
# 兼容旧格式解析：CHANGE <handle> <pid> <processName> <b64> 或 CHANGE <handle> <b64>。
# 句柄/进程信息用于回填前校验，避免粘贴到错误窗口；矩形/DPI 用于把建议悬浮框定位到微信输入框附近。
param([int]$PollMs = 700)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public struct XTHRECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public static class XTHClipboard {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out XTHRECT rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public static uint GetForegroundPid() {
        uint pid = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
}
"@

# 让传感器进程 DPI 感知：GetWindowRect 返回物理像素，Electron 侧再按 dpi/96 换算成 DIP。
# 失败不影响主流程（dpi 为 0 时按 96 处理）。
try { [XTHClipboard]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
    try { [XTHClipboard]::SetProcessDPIAware() | Out-Null } catch {}
}

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

        $handlePtr = [XTHClipboard]::GetForegroundWindow()
        $handle = $handlePtr.ToInt64()
        $procId = 0
        if ($handle -ne 0) {
            $procId = [XTHClipboard]::GetForegroundPid()
        }
        $pname = '-'
        if ($procId -gt 0) {
            try { $pname = (Get-Process -Id $procId).ProcessName } catch {}
        }
        if (-not $pname) { $pname = '-' }

        $left = 0; $top = 0; $right = 0; $bottom = 0; $dpi = 0
        if ($handle -ne 0 -and [XTHClipboard]::IsWindow($handlePtr)) {
            $rect = New-Object XTHRECT
            $ok = [XTHClipboard]::GetWindowRect($handlePtr, [ref]$rect)
            if ($ok -and $rect.Right -gt $rect.Left -and $rect.Bottom -gt $rect.Top) {
                $left = $rect.Left
                $top = $rect.Top
                $right = $rect.Right
                $bottom = $rect.Bottom
                try { $dpi = [XTHClipboard]::GetDpiForWindow($handlePtr) } catch {}
            }
        }

        Write-Output ("CHANGE " + $handle + " " + $procId + " " + $pname + " " + $left + " " + $top + " " + $right + " " + $bottom + " " + $dpi + " " + $b64)
    }
    Start-Sleep -Milliseconds $PollMs
}
