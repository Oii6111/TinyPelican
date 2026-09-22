@echo off
rem 小鹈鹕 — 手工启动内置 DSH（排障用）
rem
rem 什么时候用它：微信/看板发起对话报 "fetch failed"、浏览器打开 http://127.0.0.1:3080 没反应，
rem 说明 DSH 后端没起来。双击本文件会**在前台**启动内置的 DSH，窗口里直接打印启动日志或报错。
rem 关闭这个窗口等于停止 DSH。
setlocal
set "CONTENT=%~dp0"
for %%I in ("%CONTENT%..\..") do set "APPDIR=%%~fI"

set "APPEXE="
for %%F in ("%APPDIR%\*.exe") do (
  if not defined APPEXE (
    echo %%~nxF | findstr /I "uninstall" >nul || set "APPEXE=%%~fF"
  )
)
if not defined APPEXE (
  echo [x] 没找到小鹈鹕主程序（%APPDIR%）
  pause
  exit /b 1
)

set "DSHBIN=%CONTENT%vendor\node_modules\@deepseek-ai\dsh\lib\bin.js"
if not exist "%DSHBIN%" (
  echo [x] 安装目录里没有内置 DSH：%DSHBIN%
  pause
  exit /b 1
)

if "%DSH_HOME%"=="" set "DSH_HOME=%APPDATA%\xiaotihu\dsh-home"
set "ELECTRON_RUN_AS_NODE=1"

echo 小鹈鹕：手工启动内置 DSH
echo   主程序  = %APPEXE%
echo   DSH     = %DSHBIN%
echo   DSH_HOME= %DSH_HOME%
echo   （首次启动会在 DSH_HOME 下生成 profile，可能需要几十秒；成功后浏览器访问 http://127.0.0.1:3080）
echo.
"%APPEXE%" "%DSHBIN%" web --port 3080 --no-open
echo.
echo [DSH 已退出] 上面的输出就是原因，请连同 %APPDATA%\xiaotihu\activity.log 一起发给开发者。
pause
