# 小鹈鹕 — 注册「聊天记录导入」系统入口（经典 Win32 路线）
#
# 作用：
#   1. 「发送到」菜单加一项「小鹈鹕 · 导入聊天记录」（多选文件也能一次性导入）
#   2. 给所有文件加右键菜单「用小鹈鹕导入聊天记录」（HKCU，免管理员）
#
# 注意：这些入口出现在 **资源管理器** 的「发送到 / 右键」，不在微信的「转发到其他应用」里。
# 微信那条走的是 Windows 分享面板（UWP ShareTarget 合约），必须把应用打包（MSIX）才能出现在列表里，
# 详见 docs/chat-import.md。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\register-import-handler.ps1            # 注册
#   powershell -ExecutionPolicy Bypass -File scripts\register-import-handler.ps1 -Unregister # 卸载
# 本文件必须保存为 UTF-8 with BOM（Windows PowerShell 5.1 无 BOM 时会按 ANSI 解码中文并解析失败）。

param([switch]$Unregister)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cmdPath = Join-Path $PSScriptRoot 'tinypelican-import.cmd'
if (-not (Test-Path $cmdPath)) { throw "找不到包装脚本：$cmdPath" }

$sendTo = Join-Path $env:APPDATA 'Microsoft\Windows\SendTo'
$shortcutPath = Join-Path $sendTo '小鹈鹕 · 导入聊天记录.lnk'
$regPath = 'HKCU:\Software\Classes\*\shell\TinyPelicanImport'

if ($Unregister) {
  if (Test-Path $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force; Write-Host "已移除「发送到」项" }
  if (Test-Path $regPath) { Remove-Item -LiteralPath $regPath -Recurse -Force; Write-Host '已移除右键菜单项' }
  Write-Host '卸载完成（HKCU 下没有留下其它改动）'
  exit 0
}

# 1) 「发送到」快捷方式
New-Item -ItemType Directory -Force -Path $sendTo | Out-Null
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcutPath)
$lnk.TargetPath = $cmdPath
$lnk.WorkingDirectory = $root
$lnk.Description = '把小鹈鹕导出的微信聊天记录（ZIP/TXT）导入本地记忆库'
$lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,70"
$lnk.Save()
Write-Host "已注册「发送到」：$shortcutPath"

# 2) 右键菜单（对所有文件生效，支持多选）
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name '(Default)' -Value '用小鹈鹕导入聊天记录'
Set-ItemProperty -Path $regPath -Name 'Icon' -Value "$env:SystemRoot\System32\shell32.dll,70"
Set-ItemProperty -Path $regPath -Name 'MultiSelectModel' -Value 'Player'
$cmdKey = Join-Path $regPath 'command'
New-Item -Path $cmdKey -Force | Out-Null
# %* 让多选文件一起传进来；cmd 里再转交 node 导入脚本
Set-ItemProperty -Path $cmdKey -Name '(Default)' -Value "`"$cmdPath`" %*"
Write-Host '已注册右键菜单：用小鹈鹕导入聊天记录'

Write-Host ''
Write-Host '用法：在资源管理器里选中微信导出的 ZIP/TXT → 右键「发送到 → 小鹈鹕 · 导入聊天记录」'
Write-Host '（若要出现在微信「转发到其他应用」列表里，需要 MSIX 打包 + 分享目标，见 docs/chat-import.md）'
