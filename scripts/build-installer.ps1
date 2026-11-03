# 小鹈鹕 — 一键构建 Windows 安装包（双击安装即用的 exe）
#
# 产物：app\dist\TinyPelican-Setup-<版本>.exe
#   - 内置 Node 运行时（packaging\runtime\node.exe → resources\content\runtime\node.exe），
#     运行时不需要用户另装 Node。这里必须是真正的 node.exe：拿 Electron 自带 Node 跑核心时
#     整棵进程树没有控制台，DSH 调用 pwsh 时系统会给每条命令新建一个可见黑窗
#     （「一用工具就疯狂弹 PowerShell 窗口」，详见 core/lib/runtime-node.js）
#   - 内置 DSH（@deepseek-ai/dsh 及其依赖，约 220MB），首次启动由它自己在用户数据目录生成 profile
#   - 只带 config.example.json；用户自己的 config.json 在首次运行时生成（绝不打包开发者的 Key）
#
# 前置：Node 22.13+ / npm，首次构建需要联网（下载运行依赖 + electron-builder 的 NSIS 工具）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
# 本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 会按 ANSI 解码中文并解析失败）。

param(
  [string]$DshVersion = '0.2.1-rc.2',
  [switch]$SkipVendorInstall,
  [switch]$SkipAppInstall,
  [string]$InstallerExportDirectory = ''
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
} else {
  Step "安装内置 DSH（@deepseek-ai/dsh@$DshVersion）"
  npm install --prefix $vendor "@deepseek-ai/dsh@$DshVersion" --save-exact
  if ($LASTEXITCODE -ne 0) { throw 'vendor 依赖安装失败' }
}
if (-not (Test-Path $dshBin)) { throw "内置 DSH 未就绪：$dshBin" }
foreach ($required in @('dshmarket\package.json', 'dshmarket\lib\index.js', 'dshmarket\cordis.patch.yml', 'dshmarket\client\client.js')) {
  if (-not (Test-Path (Join-Path $vendor "node_modules\$required"))) {
    throw "Missing bundled plugin: $required. Run npm install --prefix packaging/vendor before packaging."
  }
}

# 1.1) 让内置 DSH 认领随包市场包：DSH 的安装作用域只认 @deepseek-ai/dsh 自己的依赖图，
# 光把 dshmarket 放在 vendor/node_modules 里，profile 一登记就会报
# 「dsh-market (dshmarket): Cannot find package 'dshmarket'」。
Step '内置 DSH 依赖声明'
node (Join-Path $root 'scripts\patch-vendor-dsh.js') $dshBin
if ($LASTEXITCODE -ne 0) { throw '内置 DSH 依赖修补失败' }

# 1.2) 随包 DSH 插件：浏览器半边是已构建好的 CJS bundle（无需 tsc/tsdown），
# 只校验产物齐全，避免装出一个「插件页少一个入口」的包。
Step '随包 DSH 插件'
$bundledPlugins = Join-Path $root 'agent\dsh-plugins'
$requiredPluginFiles = @(
  'tinypelican-market\package.json',
  'tinypelican-market\cordis.patch.yml',
  'tinypelican-market\lib\index.js',
  'tinypelican-market\client\client.js'
)
foreach ($rel in $requiredPluginFiles) {
  $file = Join-Path $bundledPlugins $rel
  if (-not (Test-Path $file)) { throw "随包插件缺少文件：$file" }
}
Write-Host "随包插件已就绪：$bundledPlugins"

# 1.5) 内置 Node 运行时：复制构建机上的 node.exe（控制台子系统）
# 为什么不能用 Electron 当 Node：electron.exe 是 GUI 子系统程序，当 Node 用时进程没有控制台，
# 而 DSH 执行工具命令走的是它自带的 windows-job runner（原生 CreateProcessW，不带
# CREATE_NO_WINDOW），pwsh.exe 在「父进程没有控制台」时会被系统配一个新控制台窗口 ——
# 打包版「一用工具就疯狂弹 PowerShell 窗口」的根源。换成 node.exe 后它被 windowsHide 启动，
# 隐藏控制台一路继承给 DSH / runner / pwsh，DSH 内部那些没带 windowsHide 的 spawn 也不再冒窗。
Step '内置 Node 运行时（node.exe）'
$runtime = Join-Path $root 'packaging\runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd -or -not $nodeCmd.Source) { throw '找不到 node：构建机需要 Node 22.13+（先装好 Node 再跑 npm run dist）' }
if ([IO.Path]::GetFileName($nodeCmd.Source) -ne 'node.exe') { throw "PATH 上的 node 不是 node.exe：$($nodeCmd.Source)" }
$nodeVersion = (& $nodeCmd.Source '-p' 'process.versions.node').Trim()
if ([int]($nodeVersion.Split('.')[0]) -lt 22) { throw "构建机 Node 版本过低（需要 >= 22.13）：v$nodeVersion" }
Copy-Item -Force $nodeCmd.Source (Join-Path $runtime 'node.exe')
Write-Host "已内置 node.exe：$runtime（v$nodeVersion）"

# 2) Electron 与打包工具
if (-not $SkipAppInstall) {
  Step '安装 app 依赖（electron / electron-builder）'
  npm install --prefix $app
  if ($LASTEXITCODE -ne 0) { throw 'app 依赖安装失败' }
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
  $previousCompressionLevel = $env:ELECTRON_BUILDER_COMPRESSION_LEVEL
  $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
  npm run dist
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder 构建失败' }
} finally {
  $env:ELECTRON_BUILDER_COMPRESSION_LEVEL = $previousCompressionLevel
  Pop-Location
}

# 4) 汇报产物
Step '产物'
$dist = Join-Path $app 'dist'
$exe = Get-ChildItem $dist -File -Filter 'TinyPelican-Setup-*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw "没有找到安装包，检查 $dist 下的日志" }
$sizeMb = [Math]::Round($exe.Length / 1MB, 1)
$exportedInstaller = & (Join-Path $PSScriptRoot 'export-installer.ps1') -InstallerPath $exe.FullName -OutputDirectory $InstallerExportDirectory
Write-Host "构建目录：$($exe.FullName)"
Write-Host "安装包：$exportedInstaller（$sizeMb MB）"
Write-Host ''
Write-Host '分发说明：'
Write-Host '  1. 把这个 exe 发给用户，双击即可安装（默认装到当前用户目录，无需管理员）；'
Write-Host '  2. 安装完成后会自动启动小鹈鹕；首次启动会在用户数据目录生成 config.json 与 dsh-home；'
Write-Host '  3. 用户只需在「设置 → 模型服务」填入自己的模型 API Key（微信通道再扫码登录一次）。'
