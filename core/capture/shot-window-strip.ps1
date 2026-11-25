param(
  [Parameter(Mandatory=$true)][long]$Handle,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$StripHeight = 150
)
# Capture only the top strip of a window (title bar + chat header). Never the message body.
# ASCII only: PowerShell 5.1 parses BOM-less .ps1 as ANSI, non-ASCII literals get mangled.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ShotWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

[ShotWin]::SetProcessDPIAware() | Out-Null
$hwnd = [IntPtr]$Handle
if ($hwnd -eq [IntPtr]::Zero -or -not [ShotWin]::IsWindow($hwnd)) { Write-Output 'ERR no-window'; exit 3 }

$rect = New-Object ShotWin+RECT
[ShotWin]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Output 'ERR empty-rect'; exit 4 }

$full = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($full)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT: needed for Qt/Electron windows that paint into a compositor
$ok = [ShotWin]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { $full.Dispose(); Write-Output 'ERR printwindow'; exit 5 }

$stripH = [Math]::Min($StripHeight, $h)
$strip = New-Object System.Drawing.Bitmap $w, $stripH
$sg = [System.Drawing.Graphics]::FromImage($strip)
$src = New-Object System.Drawing.Rectangle 0, 0, $w, $stripH
$sg.DrawImage($full, $src, $src, [System.Drawing.GraphicsUnit]::Pixel)
$sg.Dispose()
$full.Dispose()

# PrintWindow on a covered / minimized Qt window often returns a flat color.
# Feeding that to the model wastes a vision call, so reject it at the source:
# sample the strip and check the luminance spread.
$stepX = [Math]::Max(1, [int]($w / 60))
$stepY = [Math]::Max(1, [int]($stripH / 12))
$sum = 0.0; $count = 0; $values = New-Object System.Collections.Generic.List[double]
for ($x = 0; $x -lt $w; $x += $stepX) {
  for ($y = 0; $y -lt $stripH; $y += $stepY) {
    $c = $strip.GetPixel($x, $y)
    $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
    $values.Add($lum); $sum += $lum; $count++
  }
}
$mean = $sum / [Math]::Max(1, $count)
$dev = 0.0
foreach ($v in $values) { $dev += [Math]::Abs($v - $mean) }
$dev = $dev / [Math]::Max(1, $count)
if ($dev -lt 3.0) {
  $strip.Dispose()
  Write-Output ("ERR blank dev=" + [Math]::Round($dev, 2))
  exit 6
}

$strip.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$strip.Dispose()

Write-Output ("OK " + $w + "x" + $stripH)
