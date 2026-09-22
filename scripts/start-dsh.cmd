@echo off
rem TinyPelican - start the bundled DSH backend (diagnostic launcher).
rem Keep this file ASCII-only: cmd.exe reads .cmd in the OEM code page, and
rem non-ASCII text here can break parsing on Chinese Windows (window closes instantly).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dsh.ps1"
echo.
pause
