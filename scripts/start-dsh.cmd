@echo off
rem TinyPelican - start the bundled DSH backend (diagnostic launcher).
rem
rem This shell is deliberately ASCII-only. cmd.exe reads .cmd files in the OEM
rem code page, so Chinese characters here get mis-decoded and break the parser:
rem the window then closes instantly, before even "pause" runs. Keep it ASCII,
rem and always end with pause so an error stays on screen.
rem
rem Where to put it: next to TinyPelican.exe (inside resources\content) is best.
rem Both files may also sit anywhere else (e.g. the desktop): the install folder
rem is then located under %LOCALAPPDATA%\Programs and passed to start-dsh.js.
title TinyPelican DSH
setlocal EnableExtensions

set "CONTENT="
if exist "%~dp0start-dsh.js" if exist "%~dp0vendor\node_modules\@deepseek-ai\dsh\lib\bin.js" set "CONTENT=%~dp0"
if not defined CONTENT if exist "%~dp0resources\content\core\index.js" set "CONTENT=%~dp0resources\content"
if not defined CONTENT for /d %%D in ("%LOCALAPPDATA%\Programs\*") do if not defined CONTENT if exist "%%~fD\resources\content\core\index.js" set "CONTENT=%%~fD\resources\content"
if not defined CONTENT for /d %%D in ("%ProgramFiles%\*") do if not defined CONTENT if exist "%%~fD\resources\content\core\index.js" set "CONTENT=%%~fD\resources\content"

if not defined CONTENT (
  echo [x] Could not find the TinyPelican install folder.
  echo     Looked next to this file and under "%LOCALAPPDATA%\Programs".
  echo     Reinstall TinyPelican, or copy start-dsh.cmd and start-dsh.js into
  echo     ...\resources\content next to TinyPelican.exe.
  goto :done
)

for %%I in ("%CONTENT%\..\..") do set "APPDIR=%%~fI"

set "APPEXE="
for /f "delims=" %%F in ('dir /b /a-d /o-s "%APPDIR%\*.exe" 2^>nul') do if not defined APPEXE set "APPEXE=%APPDIR%\%%F"
if not defined APPEXE (
  echo [x] No TinyPelican.exe under "%APPDIR%".
  goto :done
)

if not exist "%CONTENT%\vendor\node_modules\@deepseek-ai\dsh\lib\bin.js" (
  echo [x] The bundled DSH is missing:
  echo     "%CONTENT%\vendor\node_modules\@deepseek-ai\dsh\lib\bin.js"
  echo     Antivirus may have cleaned the install folder - reinstall TinyPelican.
  goto :done
)

set "ENTRY=%~dp0start-dsh.js"
if not exist "%ENTRY%" set "ENTRY=%CONTENT%\start-dsh.js"
if not exist "%ENTRY%" (
  echo [x] start-dsh.js is missing next to this file and in "%CONTENT%".
  goto :done
)

if not defined XIAOTIHU_DATA_DIR set "XIAOTIHU_DATA_DIR=%APPDATA%\xiaotihu"
if not defined DSH_HOME set "DSH_HOME=%XIAOTIHU_DATA_DIR%\dsh-home"
if not defined XIAOTIHU_DSH_BIN set "XIAOTIHU_DSH_BIN=%CONTENT%\vendor\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "XIAOTIHU_CONTENT_DIR=%CONTENT%"
rem Run the bundled Electron as if it were Node.
set "ELECTRON_RUN_AS_NODE=1"

echo TinyPelican: DSH self-check + manual start
echo   app     = %APPEXE%
echo   content = %CONTENT%
echo.

"%APPEXE%" "%ENTRY%"
set "CODE=%ERRORLEVEL%"

echo.
echo [DSH exited] code %CODE%. The output above is the reason.
echo Log file (if any): %XIAOTIHU_DATA_DIR%\dsh.log

:done
echo.
pause
