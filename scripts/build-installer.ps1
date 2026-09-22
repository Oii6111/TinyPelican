# 小鹈鹕 — 一键构建 Windows 安装包（双击安装即用的 exe）
#
# 产物：app\dist\TinyPelican-Setup-<版本>.exe
#   - 内置 Electron 自带的 Node，运行时不需要用户另装 Node
#   - 内置 DSH（@deepseek-ai/dsh 及其依赖，约 220MB），首次启动由它自己在用户数据目录生成 profile
#   - 只带 config.example.json；用户自己的 config.json 在首次运行时生成（绝不打包开发者的 Key）
#
# 前置：Node 18+ / npm，首次构建需要联网（下载 DSH 依赖 + electron-builder 的 NSIS 工具）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
# 本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 会按 ANSI 解码中文并解析失败）。

param(
  [string]$DshVersion = '0.1.5-rc.2',
  [switch]$SkipVendorInstall,
  [switch]$SkipAppInstall
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$vendor = Join-Path $root 'packaging\vendor'
$app = Join-Path $root 'app'

function Step($text) { Write-Host ''; Write-Host ("== " + $text) }

# 1) 内置 DSH（装到 packaging/vendor/node_modules，打包时复制进安装目录）
$dshBin = Join-Path $vendor 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if ($SkipVendorInstall) {
  Write-Host '跳过 vendor 安装'
} elseif (Test-Path $dshBin) {
  Write-Host "vendor 已存在（$dshBin）"
} else {
  Step "安装内置 DSH（@deepseek-ai/dsh@$DshVersion）"
  npm install --prefix $vendor "@deepseek-ai/dsh@$DshVersion"
}
if (-not (Test-Path $dshBin)) { throw "内置 DSH 未就绪：$dshBin" }

# 2) Electron 与打包工具
if (-not $SkipAppInstall) {
  Step '安装 app 依赖（electron / electron-builder）'
  npm install --prefix $app
}

# 2.5) 生成安装包图标（electron-builder 要求 ≥256×256；源图 logo2.png 非正方形，这里居中缩放到 512）
Step '生成安装包图标'
Add-Type -AssemblyName System.Drawing
$srcPng = Join-Path $root 'logo2.png'
$iconDir = Join-Path $app 'build'
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
$iconPng = Join-Path $iconDir 'icon.png'
$src = [System.Drawing.Image]::FromFile($srcPng)
try {
  $size = 512
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)
  $ratio = [Math]::Min($size / $src.Width, $size / $src.Height)
  $w = [int]($src.Width * $ratio); $h = [int]($src.Height * $ratio)
  $g.DrawImage($src, [int](($size - $w) / 2), [int](($size - $h) / 2), $w, $h)
  $g.Dispose()
  $bmp.Save($iconPng, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} finally {
  $src.Dispose()
}
Write-Host "图标已生成：$iconPng（512×512）"

# 3) 打包
Step 'electron-builder 构建安装包'
Push-Location $app
try {
  npm run dist
} finally {
  Pop-Location
}

# 4) 汇报产物
Step '产物'
$dist = Join-Path $app 'dist'
$exe = Get-ChildItem $dist -File -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw "没有找到安装包，检查 $dist 下的日志" }
Write-Host ("安装包：{0}（{1} MB）" -f $exe.FullName, [Math]::Round($exe.Length / 1MB, 1))
Write-Host ''
Write-Host '分发说明：'
Write-Host '  1. 把这个 exe 发给用户，双击即可安装（默认装到当前用户目录，无需管理员）；'
Write-Host '  2. 安装完成后会自动启动小鹈鹕；首次启动会在用户数据目录生成 config.json 与 dsh-home；'
Write-Host '  3. 用户只需在「设置 → 模型服务」填入自己的模型 API Key（微信通道再扫码登录一次）。'
