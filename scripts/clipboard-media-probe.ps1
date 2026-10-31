# TinyPelican - clipboard media probe (one-shot, NOT part of the resident pipeline).
#
# What it shows: when you copy a WeChat chat that contains images, how does the
# image actually reach the clipboard?
#
# Compliance boundary (deliberately limited):
#   1. Reads only what WeChat itself puts on the clipboard, via the public
#      clipboard API (CF_UNICODETEXT / CF_HDROP / WeChat private format).
#   2. Copies only the plain file WeChat already decrypted into its own RWTemp dir.
#   3. Never opens, reads or decrypts the WeChat database or .dat store.
#   4. Does not modify the clipboard, writes nothing outside -OutDir.
#
# Output: one line of JSON on stdout (formats / text / drop / wechat / files).
# NOTE: ASCII-only source on purpose - Windows PowerShell 5.1 reads BOM-less
# files as ANSI and would choke on CJK comments.

param(
  [string]$OutDir = '',
  [switch]$NoCopy,
  [int]$MaxBytes = 104857600
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-ImageInfo([string]$path) {
  try {
    $img = [System.Drawing.Image]::FromFile($path)
    try {
      return @{ width = $img.Width; height = $img.Height; pixelFormat = [string]$img.PixelFormat }
    } finally { $img.Dispose() }
  } catch { return $null }
}

function Get-Magic([string]$path) {
  try {
    $fs = [System.IO.File]::OpenRead($path)
    try {
      $buf = New-Object byte[] 12
      $n = $fs.Read($buf, 0, 12)
      if ($n -le 0) { return '' }
      return (($buf[0..($n - 1)] | ForEach-Object { $_.ToString('x2') }) -join ' ')
    } finally { $fs.Dispose() }
  } catch { return '' }
}

$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -eq $data) {
  [pscustomobject]@{ ok = $false; error = 'clipboard empty or unavailable' } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

$formats = @($data.GetFormats($true))

# -- text -------------------------------------------------------------------
$text = ''
try { $text = [string]$data.GetData('UnicodeText', $true) } catch {}
if (-not $text) { try { $text = [string]$data.GetData('Text', $true) } catch {} }

# -- CF_HDROP (WeChat puts the decrypted file path here) ---------------------
$dropPaths = @()
try {
  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    $dropPaths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })
  }
} catch {}
if (-not $dropPaths.Count -and ($formats -contains 'FileDrop')) {
  try { $dropPaths = @($data.GetData('FileDrop', $true) | ForEach-Object { [string]$_ }) } catch {}
}

# -- WeChat private format: authoritative file <-> text mapping --------------
$wechatJson = $null
$wechatItems = @()
try {
  $stream = $data.GetData('x-xwechat-multiselect-copy', $true)
  if ($stream -is [System.IO.MemoryStream]) {
    $bytes = $stream.ToArray()
    $wechatJson = [System.Text.Encoding]::UTF8.GetString($bytes).Trim()
    if ($wechatJson) {
      $parsed = $wechatJson | ConvertFrom-Json
      $wechatItems = @($parsed)
    }
  }
} catch {}

# -- copy the dropped files -------------------------------------------------
$outRoot = $OutDir
if (-not $outRoot) {
  $outRoot = Join-Path (Split-Path -Parent $PSScriptRoot) ('tmp\clipboard-probe\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$files = @()
if (-not $NoCopy) {
  foreach ($src in $dropPaths) {
    $entry = [ordered]@{ source = $src; name = (Split-Path -Leaf $src) }
    try {
      if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { $entry.error = 'source missing'; $files += $entry; continue }
      $info = Get-Item -LiteralPath $src
      $entry.bytes = $info.Length
      if ($info.Length -gt $MaxBytes) { $entry.error = 'over MaxBytes limit, skipped'; $files += $entry; continue }
      New-Item -ItemType Directory -Force -Path $outRoot | Out-Null
      # hash prefix: no name collisions, and the original path never leaks into the file name
      $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
      $dest = Join-Path $outRoot ($hash + '-' + $entry.name)
      Copy-Item -LiteralPath $src -Destination $dest -Force
      $entry.copiedTo = $dest
      $entry.magic = Get-Magic $dest
      $img = Get-ImageInfo $dest
      if ($img) { $entry.image = $img }
      $entry.sha256 = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    } catch {
      $entry.error = $_.Exception.Message
    }
    $files += $entry
  }
}

[pscustomobject][ordered]@{
  ok       = $true
  at       = (Get-Date).ToString('o')
  outDir   = $outRoot
  formats  = $formats
  hasImage = ($formats -contains 'Bitmap') -or ($formats -contains 'System.Drawing.Bitmap')
  text     = $text
  wechat   = $wechatItems
  files    = $files
} | ConvertTo-Json -Depth 10 -Compress
