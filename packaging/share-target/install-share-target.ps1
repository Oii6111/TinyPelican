# 小鹈鹕 — 构建并注册「分享目标」（微信「转发到其他应用」里出现小鹈鹕）
#
# 做什么：
#   1. 用 dotnet 发布 C# shim（无控制台窗口）
#   2. 组装 MSIX 包布局（AppxManifest.xml + Assets + tinypelican.json）
#   3. Add-AppxPackage -Register 注册（开发模式免签名；卸载用 -Unregister）
#
# 前提：Windows 10 19041+、.NET SDK 8+、**已开启开发者模式**（设置 → 系统 → 开发者选项）。
# 用法：
#   powershell -ExecutionPolicy Bypass -File packaging\share-target\install-share-target.ps1
#   powershell -ExecutionPolicy Bypass -File packaging\share-target\install-share-target.ps1 -Unregister
# 本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 会按 ANSI 解码中文并解析失败）。

param(
  [switch]$Unregister,
  [string]$Root = '',
  [string]$Configuration = 'Release',
  [switch]$SkipSignCheck
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
if (-not $Root) { $Root = (Resolve-Path (Join-Path $here '..\..')).Path }
$packageName = 'TinyPelican.ShareTarget'

if ($Unregister) {
  $pkg = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue
  if ($pkg) {
    Remove-AppxPackage -Package $pkg.PackageFullName
    Write-Host "已卸载分享目标：$($pkg.PackageFullName)"
  } else {
    Write-Host '没有已注册的分享目标'
  }
  exit 0
}

$layout = Join-Path $here 'layout'
$appDir = Join-Path $layout 'app'
$assetsDir = Join-Path $layout 'Assets'
if (Test-Path $layout) { Remove-Item -LiteralPath $layout -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appDir, $assetsDir | Out-Null

# ── 1) 发布 shim ───────────────────────────────────────────────────────────
$env:DOTNET_CLI_HOME = Join-Path $env:TEMP 'tinypelican-dotnet'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$proj = Join-Path $here 'TinyPelicanShareTarget\TinyPelicanShareTarget.csproj'
Write-Host '发布 shim…'
& dotnet publish $proj -c $Configuration -r win-x64 --self-contained false -o $appDir --nologo | Write-Host
if (-not (Test-Path (Join-Path $appDir 'TinyPelicanShareTarget.exe'))) { throw 'shim 编译产物缺失' }

# ── 2) 图标（按清单声明生成 44/150/50 三种尺寸）────────────────────────────
Add-Type -AssemblyName System.Drawing
$logo = Join-Path $Root 'logo2.png'
if (Test-Path $logo) {
  $src = [System.Drawing.Image]::FromFile($logo)
  foreach ($spec in @(@{ n = 'Square44x44Logo.png'; s = 44 }, @{ n = 'Square150x150Logo.png'; s = 150 }, @{ n = 'StoreLogo.png'; s = 50 })) {
    $bmp = New-Object System.Drawing.Bitmap($spec.s, $spec.s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.Clear([System.Drawing.Color]::Transparent)
    # 等比缩放居中
    $ratio = [Math]::Min($spec.s / $src.Width, $spec.s / $src.Height)
    $w = [int]($src.Width * $ratio); $h = [int]($src.Height * $ratio)
    $g.DrawImage($src, [int](($spec.s - $w) / 2), [int](($spec.s - $h) / 2), $w, $h)
    $g.Dispose()
    $bmp.Save((Join-Path $assetsDir $spec.n), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
  $src.Dispose()
  Write-Host '已生成包图标'
} else {
  throw "找不到图标源文件：$logo"
}

# ── 3) 清单 + 配置 ─────────────────────────────────────────────────────────
Copy-Item (Join-Path $here 'AppxManifest.xml') $layout -Force
$config = @{ root = $Root; askContact = $true; nodePath = '' } | ConvertTo-Json
# 包内文件按 UTF-8（无 BOM）写入，避免 shim 读 JSON 时被 BOM 干扰
[IO.File]::WriteAllText((Join-Path $appDir 'tinypelican.json'), $config, (New-Object System.Text.UTF8Encoding($false)))

# ── 4) 注册 ────────────────────────────────────────────────────────────────
Write-Host '注册到系统（开发模式免签名）…'
Add-AppxPackage -Register (Join-Path $layout 'AppxManifest.xml')
$pkg = Get-AppxPackage -Name $packageName
Write-Host ("已注册：{0}  版本 {1}" -f $pkg.PackageFullName, $pkg.Version)
Write-Host ''
Write-Host '下一步：在微信里选中聊天记录 → 转发 → 转发到其他应用 → 应能看到「小鹈鹕 · 聊天记录导入」'
