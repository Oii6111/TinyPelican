@echo off
rem 小鹈鹕 — 聊天记录导入包装脚本
rem 用途：作为「发送到」目标或右键菜单命令，把微信导出的 ZIP/TXT 交给核心导入。
rem 用法：tinypelican-import.cmd <文件或目录...>
setlocal
set "ROOT=%~dp0.."
set "NODE=node"

if "%~1"=="" (
  echo 用法：把微信导出的聊天记录文件（ZIP/TXT/CSV/JSON）拖到本脚本上，
  echo       或：tinypelican-import.cmd "C:\path\to\微信聊天记录.zip"
  pause
  exit /b 1
)

pushd "%ROOT%"
"%NODE%" "core\import\chat-archive.js" %* --json > "%TEMP%\tinypelican-import.json" 2>"%TEMP%\tinypelican-import.err"
set "CODE=%ERRORLEVEL%"
popd

rem 给用户一个可见反馈（没有弹窗时导出流程会显得「什么都没发生」）
powershell -NoProfile -Command "$json = Get-Content '%TEMP%\tinypelican-import.json' -Raw -ErrorAction SilentlyContinue; $err = Get-Content '%TEMP%\tinypelican-import.err' -Raw -ErrorAction SilentlyContinue; try { $s = $json | ConvertFrom-Json } catch {}; if ($s) { $body = ('导入 ' + $s.files.Count + ' 个文件，解析 ' + $s.messages + ' 条消息，新增 ' + $s.added + ' 条。') } else { $body = ('导入失败：' + ($err -replace '\s+$','')) }; Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($body, '小鹈鹕 · 聊天记录导入') | Out-Null"
exit /b %CODE%
