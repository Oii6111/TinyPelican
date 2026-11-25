# 小鹈鹕 — 剪贴板传感器（常驻轻量进程）
# 检测到剪贴板变化时输出：
#   CHANGE <handle> <pid> <processName> <left> <top> <right> <bottom> <dpi> <b64>
# 兼容旧格式解析：CHANGE <handle> <pid> <processName> <b64> 或 CHANGE <handle> <b64>。
# 句柄/进程信息用于回填前校验，避免粘贴到错误窗口；矩形/DPI 用于把建议悬浮框定位到微信输入框附近。
#
# 带附件时会在 CHANGE 之前多输出一行：
#   MEDIA <b64(UTF-8 JSON)>
# JSON：{ files:[{path,name}], wechat:[{file?,text}], hasImage:bool }
#   files  = CF_HDROP 里的明文文件（微信复制图片时给的 temp\RWTemp\*.jpg）
#   wechat = 私有格式 x-xwechat-multiselect-copy 的 item 数组，第 i 项对应第 i 条消息
# 只读剪贴板本身，不打开微信数据库、不解密 .dat；旧版 Node 侧会忽略 MEDIA 行。
param([int]$PollMs = 700)

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$nativeAvailable = $false
try {
Add-Type -ErrorAction Stop @"
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
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();

    public static uint GetForegroundPid() {
        uint pid = 0;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return pid;
    }
}
"@
$nativeAvailable = $true
} catch {
    Write-Output ('SENSOR_ERROR ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message)))
}

# 让传感器进程 DPI 感知：GetWindowRect 返回物理像素，Electron 侧再按 dpi/96 换算成 DIP。
# 失败不影响主流程（dpi 为 0 时按 96 处理）。
try { [XTHClipboard]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {
    try { [XTHClipboard]::SetProcessDPIAware() | Out-Null } catch {}
}

# 读剪贴板上的附件清单：CF_HDROP 的明文文件 + 微信私有格式里的 item 映射。
# 全部失败也不影响文本捕获，返回 $null 表示这次没有附件。
function Get-ClipboardMedia {
    $files = New-Object System.Collections.ArrayList
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
            foreach ($p in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
                if ($p) { [void]$files.Add([pscustomobject]@{ path = [string]$p; name = [System.IO.Path]::GetFileName([string]$p) }) }
            }
        }
    } catch {}

    $wechat = New-Object System.Collections.ArrayList
    try {
        $data = [System.Windows.Forms.Clipboard]::GetDataObject()
        if ($data) {
            $stream = $data.GetData('x-xwechat-multiselect-copy', $true)
            if ($stream -is [System.IO.MemoryStream]) {
                $json = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
                if ($json) {
                    $items = $json | ConvertFrom-Json
                    foreach ($item in @($items)) {
                        $entry = [ordered]@{}
                        if ($item.file) { $entry.file = [string]$item.file }
                        if ($item.text) { $entry.text = [string]$item.text }
                        [void]$wechat.Add([pscustomobject]$entry)
                    }
                }
            }
        }
    } catch {}

    if ($files.Count -eq 0 -and $wechat.Count -eq 0) { return $null }
    $hasImage = $false
    try { $hasImage = [System.Windows.Forms.Clipboard]::ContainsImage() } catch {}
    return [pscustomobject]@{ files = @($files); wechat = @($wechat); hasImage = $hasImage }
}

$last = ''
$lastSequence = 0
$readFailed = $false
$reported = $false
while ($true) {
    Write-Output 'HEARTBEAT'
    $sequence = 0
    if ($nativeAvailable) { $sequence = [XTHClipboard]::GetClipboardSequenceNumber() }
    try {
        $clip = Get-Clipboard -Raw -ErrorAction Stop
        $readFailed = $false
    } catch {
        if (-not $readFailed) {
            Write-Output ('SENSOR_ERROR ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message)))
        }
        $readFailed = $true
        $clip = $last
    }
    if (-not $reported) {
        Write-Output ('SENSOR_READY ' + $clip.Length)
        $reported = $true
    }
    if ($clip -and ($clip -ne $last -or $sequence -ne $lastSequence)) {
        $last = $clip
        $lastSequence = $sequence
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($clip)
        $b64 = [Convert]::ToBase64String($bytes)

        # MEDIA 行必须先于 CHANGE 输出：Node 侧按顺序把最近一条 MEDIA 交给紧随的 CHANGE
        try {
            $media = Get-ClipboardMedia
            if ($media) {
                $mediaJson = $media | ConvertTo-Json -Depth 5 -Compress
                $mediaB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($mediaJson))
                Write-Output ("MEDIA " + $mediaB64)
            }
        } catch {}

        $handle = 0
        $procId = 0
        $pname = '-'
        if ($nativeAvailable) {
            try {
                $handlePtr = [XTHClipboard]::GetForegroundWindow()
                $handle = $handlePtr.ToInt64()
                if ($handle -ne 0) { $procId = [XTHClipboard]::GetForegroundPid() }
            } catch { $handle = 0; $procId = 0 }
        }
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
