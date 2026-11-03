!macroundef extractUsing7za
!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  SetOutPath "$PLUGINSDIR\7z-out"
  ClearErrors
  Nsis7z::Extract "${FILE}"
  Pop $R0
  SetOutPath $R0
  nsExec::ExecToStack /TIMEOUT=120000 '"$SYSDIR\robocopy.exe" "$PLUGINSDIR\7z-out" "$OUTDIR" /E /MOVE /MT:8 /R:0 /W:0 /NFL /NDL /NJH /NJS /NP'
  Pop $R0
  Pop $R1
  ${If} $R0 == "error"
  ${OrIf} $R0 == "timeout"
    SetErrorLevel 2
    Abort "Unable to move extracted application files."
  ${EndIf}
  ${If} $R0 >= 8
    SetErrorLevel 2
    Abort "Unable to move extracted application files."
  ${EndIf}
!macroend
