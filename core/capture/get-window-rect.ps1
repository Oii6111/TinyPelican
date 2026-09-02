# 小鹈鹕 — 按句柄读取窗口矩形与 DPI（建议卡片显示时刷新定位）
# 输出：OK <pid> <left> <top> <right> <bottom> <dpi>
# 失败（句柄无效/窗口已销毁）输出：FAIL
param([long]$Handle = 0)

if ($Handle -eq 0) {
    Write-Output 'FAIL'
    exit 1
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public struct XTHRECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public static class XTHWindowRect {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out XTHRECT rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public static uint GetPid(IntPtr hWnd) {
        uint pid = 0;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }
}
"@

# 与传感器保持一致：DPI 感知进程读物理像素，Node 侧按 dpi/96 换算。
try { [XTHWindowRect]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
    try { [XTHWindowRect]::SetProcessDPIAware() | Out-Null } catch {}
}

$h = [IntPtr]$Handle
if (-not [XTHWindowRect]::IsWindow($h)) {
    Write-Output 'FAIL'
    exit 1
}

$rect = New-Object XTHRECT
$ok = [XTHWindowRect]::GetWindowRect($h, [ref]$rect)
if (-not $ok -or $rect.Right -le $rect.Left -or $rect.Bottom -le $rect.Top) {
    Write-Output 'FAIL'
    exit 1
}

$procId = [XTHWindowRect]::GetPid($h)

$dpi = 0
try { $dpi = [XTHWindowRect]::GetDpiForWindow($h) } catch {}

Write-Output ("OK " + $procId + " " + $rect.Left + " " + $rect.Top + " " + $rect.Right + " " + $rect.Bottom + " " + $dpi)
