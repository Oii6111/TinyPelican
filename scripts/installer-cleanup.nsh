; The upstream NSIS helper treats every process whose executable lives below
; $INSTDIR as the application. That catches transient updater/helper processes
; and can leave the installer in a permanent "cannot close" retry loop.
; Match only the real application executable name instead.
!define TINYPELICAN_INSTALLER_INCLUDE_DIR "${__FILEDIR__}"

!macro customInit
  ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 != ""
    Push $R0
    Call GetInQuotes
    Pop $R1
    # 只清掉「卸载器文件已不存在」的陈旧键。另一种陈旧形态是「记录说有旧安装，实际目录已经
    # 被手工删掉」：此时卸载器照样在，但旧卸载器会以 exit 1 退出，而 electron-builder 的
    # handleUninstallResult 会把任何非 0 退出码当成「应用还在运行」，重试到第 5 次就弹
    # 「应用无法关闭」并中止安装 —— 正是「明明没在跑，却装不上」的根因。这里把目录缺失视为
    # 陈旧安装一并清掉（安装包不做自动更新，不会有「目录被挪走」的正常升级场景）。
    ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R1 == ""
    ${OrIfNot} ${FileExists} "$R1"
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    ${ElseIf} $R2 != ""
    ${AndIfNot} ${FileExists} "$R2\${APP_EXECUTABLE_FILENAME}"
      DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    ${EndIf}
  ${EndIf}
!macroend

!macro tinyPelicanKillInstallDirProcesses
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec /TIMEOUT=15000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -C "Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq '$INSTDIR\resources\content\runtime\node.exe' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  !else
    nsExec::Exec /TIMEOUT=15000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -C "Get-Process -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq '$INSTDIR\resources\content\runtime\node.exe' -and $$_.SessionId -eq (Get-Process -Id $$PID).SessionId } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  !endif
  Pop $R1
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !ifndef TINYPELICAN_FAST_EXTRACTION
      !define TINYPELICAN_FAST_EXTRACTION
      !include "${TINYPELICAN_INSTALLER_INCLUDE_DIR}\installer-extract.nsh"
    !endif
  !endif
  !ifdef BUILD_UNINSTALLER
    Var /GLOBAL tinyPelicanUninstallDir
    StrCpy $tinyPelicanUninstallDir $INSTDIR
  !endif
  !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    # 覆盖安装 / 静默升级时上游默认「等应用自己退出」，但不提示也不强制。
    # 而我们的核心进程（node.exe）不是外壳的子任务，外壳退出不代表它们退出，
    # 这里对 --updated 一并处理，保证旧安装目录的进程树在解压前就已清空。
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +3
    SetErrorLevel 2
    Quit
    DetailPrint "$(appClosing)"
    !insertmacro nsProcess::CloseProcess "${APP_EXECUTABLE_FILENAME}" $R0
    Sleep 1000
    !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      !insertmacro nsProcess::KillProcess "${APP_EXECUTABLE_FILENAME}" $R0
      Sleep 1500
      !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
    ${EndIf}
    # 外壳已退出，但 content\runtime\node.exe（核心）与 DSH 可能还占着安装目录里的文件
    !insertmacro tinyPelicanKillInstallDirProcesses
    Sleep 1000
    !insertmacro nsProcess::FindProcess "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      MessageBox MB_OK|MB_ICONSTOP "$(appCannotBeClosed)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${Else}
    # 外壳已经不在（用户已关窗），但核心进程可能以孤儿形式存活：同样清一遍
    !insertmacro tinyPelicanKillInstallDirProcesses
    Sleep 500
  ${EndIf}
!macroend

!macro customUnInit
  StrCpy $INSTDIR $tinyPelicanUninstallDir
!macroend

!macro customHeader
!ifdef BUILD_UNINSTALLER
Function un.tinyPelicanAtomicRMDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  FindFirst $R1 $R2 "$INSTDIR$R0\*.*"
  tinyPelicanRemoveLoop:
    StrCmp $R2 "" tinyPelicanRemoveDone
    StrCmp $R2 "." tinyPelicanRemoveNext
    StrCmp $R2 ".." tinyPelicanRemoveNext
    ${If} $R0 == ""
    ${AndIf} $R2 == "${UNINSTALL_FILENAME}"
      Goto tinyPelicanRemoveNext
    ${EndIf}
    IfFileExists "$INSTDIR$R0\$R2\*.*" tinyPelicanRemoveDirectory tinyPelicanRemoveFile
    tinyPelicanRemoveDirectory:
      CreateDirectory "$PLUGINSDIR\old-install$R0\$R2"
      Push "$R0\$R2"
      Call un.tinyPelicanAtomicRMDir
      Pop $R3
      ${If} $R3 != 0
        Goto tinyPelicanRemoveReturn
      ${EndIf}
      Goto tinyPelicanRemoveNext
    tinyPelicanRemoveFile:
      ClearErrors
      Rename "\\?\$INSTDIR$R0\$R2" "\\?\$PLUGINSDIR\old-install$R0\$R2"
      ${If} ${Errors}
        StrCpy $R3 "$INSTDIR$R0\$R2"
        Goto tinyPelicanRemoveReturn
      ${EndIf}
    tinyPelicanRemoveNext:
      FindNext $R1 $R2
      Goto tinyPelicanRemoveLoop
  tinyPelicanRemoveDone:
    StrCpy $R3 0
  tinyPelicanRemoveReturn:
    FindClose $R1
    StrCpy $R0 $R3
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd
!endif
!macroend

!macro customRemoveFiles
  ${If} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"
    Push ""
    Call un.tinyPelicanAtomicRMDir
    Pop $R0
    ${If} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"
      FileOpen $R1 "$TEMP\TinyPelican-uninstall-error.log" a
      FileWrite $R1 "Unable to move: $R0$\r$\n"
      FileClose $R1
      Push ""
      Call un.restoreFiles
      Pop $R0
      SetErrorLevel 2
      Abort "Unable to move old application files."
    ${EndIf}
  ${EndIf}
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    # 核心进程（content\runtime\node.exe）可能比外壳活得久，卸载后残留会锁住安装目录、
    # 下次重装就报「应用无法关闭」。卸载器在这里补一刀，忽略失败（进程可能本就不存在）。
    !insertmacro tinyPelicanKillInstallDirProcesses
  ${endif}
!macroend
