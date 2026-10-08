; FlowDineOS Print Agent — Windows installer (NSIS 3). knowledge/implementation/print-agent-windows.md
;
; Built by build-windows.mjs:  makensis /DVERSION=x.y.z /DSOURCE_DIR=<dir> /DOUT_FILE=<setup.exe> installer.nsi
;
; Installs to "C:\Program Files\FlowDineOS Print Agent" (admin-only writable), registers the FlowDineOSPrintAgent
; service ("FlowDineOS Print Agent") under its own virtual account NT SERVICE\FlowDineOSPrintAgent (least privilege),
; with automatic start and restart on failure. Data — pairing, token, printed-job journal, logs — lives in
; C:\ProgramData\FlowDineOS\PrintAgent, readable only by SYSTEM, Administrators and the service account.
;
; Existing installs: an older Node-based agent kept its data in C:\ProgramData\RasoiOS\PrintAgent and ran as the
; "RasoiOS Print Agent" scheduled task. On install that task is stopped and removed (two agents must never run with one
; token), and its pairing files are COPIED into the FlowDineOS folder when that folder has none. The RasoiOS folder is
; never modified or deleted. No re-pairing is needed.
;
; Silent use (IT / CI):  Setup.exe /S [/PAIRINGCODE=ABCD2345] [/SERVER=https://...]      Uninstall.exe /S [/PURGE]

Unicode true
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

!ifndef VERSION
  !error "Pass /DVERSION=x.y.z"
!endif
!ifndef SOURCE_DIR
  !error "Pass /DSOURCE_DIR=<folder with FlowDineOS.PrintAgent.exe>"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "FlowDineOS-Print-Agent-Setup.exe"
!endif

!define PRODUCT "FlowDineOS Print Agent"
!define SERVICE "FlowDineOSPrintAgent"
!define SERVICE_ACCOUNT "NT SERVICE\${SERVICE}"
!define DEFAULT_SERVER "https://flowdineos-production.up.railway.app"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE}"
!define LEGACY_TASK "RasoiOS Print Agent"

Name "${PRODUCT}"
OutFile "${OUT_FILE}"
InstallDir "$PROGRAMFILES64\${PRODUCT}"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "FlowDineOS"
VIAddVersionKey "LegalCopyright" "FlowDineOS"

Var DataDir
Var LegacyDir
Var PairingCode
Var ServerUrl
Var CodeField
Var ServerField
Var Purge
Var PurgeBox
Var Upgrade

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
Page custom PairingPage PairingPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
UninstPage custom un.PurgePage un.PurgePageLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ── Helpers ──

; RESULT = 1 when INPUT contains only letters, digits and the EXTRA characters. The pairing code and the address are
; passed to the agent as arguments, so quotes, spaces and shell characters are refused here.
!define SAFE_BASE "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
!macro ONLY_SAFE_CHARS INPUT EXTRA RESULT
  Push "${INPUT}"
  Push "${SAFE_BASE}${EXTRA}"
  Call OnlySafeChars
  Pop ${RESULT}
!macroend

; Push input, push allowed → pops 1 when every character of input is in allowed, else 0.
Function OnlySafeChars
  Exch $R1 ; allowed
  Exch
  Exch $R0 ; input
  Push $R2
  Push $R3
  Push $R4
  StrCpy $R2 0
  StrCpy $R4 1
  ${Do}
    StrCpy $R3 $R0 1 $R2
    ${If} $R3 == ""
      ${Break}
    ${EndIf}
    Push $R1
    Push $R3
    Call StrContainsExact
    Pop $R3
    ${If} $R3 != 1
      StrCpy $R4 0
      ${Break}
    ${EndIf}
    IntOp $R2 $R2 + 1
  ${Loop}
  StrCpy $R0 $R4
  Pop $R4
  Pop $R3
  Pop $R2
  ; Stack is [old $R1, old $R0]: restore both and leave the result ($R0) on the stack.
  Exch $R0
  Exch
  Pop $R1
FunctionEnd

; Push haystack, push one character → pops 1 when found (case-sensitive), else 0.
Function StrContainsExact
  Exch $R1
  Exch
  Exch $R0
  Push $R2
  Push $R3
  StrCpy $R2 0
  StrCpy $R3 0
  ${Do}
    StrCpy $R5 $R0 1 $R2
    ${If} $R5 == ""
      ${Break}
    ${EndIf}
    StrCmpS $R5 $R1 0 +3
      StrCpy $R3 1
      ${Break}
    IntOp $R2 $R2 + 1
  ${Loop}
  StrCpy $R0 $R3
  Pop $R3
  Pop $R2
  ; Stack is [old $R1, old $R0]: restore both and leave the result ($R0) on the stack.
  Exch $R0
  Exch
  Pop $R1
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${PRODUCT} needs 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
  SetRegView 64
  StrCpy $DataDir "$COMMONPROGRAMDATA\FlowDineOS\PrintAgent"
  StrCpy $LegacyDir "$COMMONPROGRAMDATA\RasoiOS\PrintAgent"
  StrCpy $ServerUrl "${DEFAULT_SERVER}"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/PAIRINGCODE=" $1
  ${IfNot} ${Errors}
    StrCpy $PairingCode $1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/SERVER=" $1
  ${IfNot} ${Errors}
    StrCpy $ServerUrl $1
  ${EndIf}
  StrCpy $Upgrade 0
  IfFileExists "$INSTDIR\FlowDineOS.PrintAgent.exe" 0 +2
    StrCpy $Upgrade 1
FunctionEnd

Function PairingPage
  ; Already paired (or an older RasoiOS pairing will be carried over): nothing to ask — skip the page.
  IfFileExists "$DataDir\credentials.json" 0 +2
    Abort
  IfFileExists "$LegacyDir\credentials.json" 0 +2
    Abort
  !insertmacro MUI_HEADER_TEXT "Pair this computer" "Connect the print agent to your restaurant."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "In FlowDineOS open Printing -> Agents -> Pair agent and type the pairing code here. You can also leave it empty and pair later (see README.txt)."
  Pop $0
  ${NSD_CreateLabel} 0 42u 100% 10u "Pairing code"
  Pop $0
  ${NSD_CreateText} 0 54u 50% 12u "$PairingCode"
  Pop $CodeField
  ${NSD_CreateLabel} 0 74u 100% 10u "FlowDineOS address"
  Pop $0
  ${NSD_CreateText} 0 86u 100% 12u "$ServerUrl"
  Pop $ServerField
  nsDialogs::Show
FunctionEnd

Function PairingPageLeave
  ${NSD_GetText} $CodeField $PairingCode
  ${NSD_GetText} $ServerField $ServerUrl
  Call ValidateInputs
FunctionEnd

Function ValidateInputs
  ${If} $PairingCode != ""
    !insertmacro ONLY_SAFE_CHARS "$PairingCode" "" $0
    ${If} $0 != 1
      MessageBox MB_ICONEXCLAMATION "The pairing code may contain only letters and digits." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
  !insertmacro ONLY_SAFE_CHARS "$ServerUrl" ":/.-_" $0
  StrCpy $1 $ServerUrl 8
  ${If} $0 != 1
  ${OrIf} $1 != "https://"
    MessageBox MB_ICONEXCLAMATION "The FlowDineOS address must start with https:// and contain no spaces or quotes." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Function StopService
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop ${SERVICE}'
  Pop $0
  ; Wait up to 30 s for the agent to finish the ticket in flight.
  StrCpy $1 0
  ${Do}
    nsExec::ExecToStack '"$SYSDIR\sc.exe" query ${SERVICE}'
    Pop $0
    Pop $2
    ${If} $0 != 0
      ${Break}
    ${EndIf}
    Push $2
    Push "STOPPED"
    Call StrContains
    Pop $4
    ${If} $4 == 1
      ${Break}
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 > 30
      ${Break}
    ${EndIf}
    Sleep 1000
  ${Loop}
FunctionEnd

; Push haystack, push needle → pops 1 when found, else 0.
Function StrContains
  Exch $R1 ; needle
  Exch
  Exch $R0 ; haystack
  Push $R2
  Push $R3
  Push $R4
  StrLen $R2 $R1
  StrCpy $R3 0
  StrCpy $R4 0
  ${Do}
    StrCpy $R5 $R0 $R2 $R3
    ${If} $R5 == $R1
      StrCpy $R4 1
      ${Break}
    ${EndIf}
    ${If} $R5 == ""
      ${Break}
    ${EndIf}
    IntOp $R3 $R3 + 1
  ${Loop}
  StrCpy $R0 $R4
  Pop $R4
  Pop $R3
  Pop $R2
  ; Stack is [old $R1, old $R0]: restore both and leave the result ($R0) on the stack.
  Exch $R0
  Exch
  Pop $R1
FunctionEnd

; ── Install / upgrade / repair ──

Section "Install"
  SetRegView 64
  SetShellVarContext all
  Call ValidateInputs

  ; 1. An older Node-based agent (scheduled task) must not keep running beside the service with the same token.
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /End /TN "${LEGACY_TASK}"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "${LEGACY_TASK}" /F'
  Pop $0

  ; 2. Stop the service before replacing its files (upgrade / repair).
  ${If} $Upgrade == 1
    DetailPrint "Upgrading: stopping ${SERVICE}"
    Call StopService
  ${EndIf}

  ; 3. Replace the binaries, keeping the previous ones until the new service is running (rollback).
  SetOutPath "$INSTDIR"
  Delete "$INSTDIR\*.rollback"
  ${If} $Upgrade == 1
    Rename "$INSTDIR\FlowDineOS.PrintAgent.exe" "$INSTDIR\FlowDineOS.PrintAgent.exe.rollback"
    Rename "$INSTDIR\FlowDineOS.PrintAgent.Service.exe" "$INSTDIR\FlowDineOS.PrintAgent.Service.exe.rollback"
  ${EndIf}
  ClearErrors
  File "${SOURCE_DIR}\FlowDineOS.PrintAgent.exe"
  File "${SOURCE_DIR}\FlowDineOS.PrintAgent.Service.exe"
  File "${SOURCE_DIR}\README.txt"
  ${If} ${Errors}
    Call Rollback
    MessageBox MB_ICONSTOP "The agent files could not be written. The previous version was restored." /SD IDOK
    Abort
  ${EndIf}

  ; 4. Data folder; carry over an older RasoiOS pairing by copying (the old folder is left untouched).
  CreateDirectory "$DataDir\logs"
  IfFileExists "$DataDir\credentials.json" data_ready
  IfFileExists "$LegacyDir\credentials.json" 0 data_ready
    DetailPrint "Carrying over the existing pairing from $LegacyDir"
    CopyFiles /SILENT "$LegacyDir\config.json" "$DataDir"
    CopyFiles /SILENT "$LegacyDir\credentials.json" "$DataDir"
    CopyFiles /SILENT "$LegacyDir\journal.json" "$DataDir"
  data_ready:

  ; 5. The service: quoted path (no unquoted-path hijack), own virtual account, delayed auto start, restart on failure.
  nsExec::ExecToStack '"$SYSDIR\sc.exe" query ${SERVICE}'
  Pop $0
  Pop $1
  ${If} $0 == 0
    nsExec::ExecToLog '"$SYSDIR\sc.exe" config ${SERVICE} binPath= "\"$INSTDIR\FlowDineOS.PrintAgent.Service.exe\"" start= delayed-auto obj= "${SERVICE_ACCOUNT}" DisplayName= "${PRODUCT}"'
  ${Else}
    nsExec::ExecToLog '"$SYSDIR\sc.exe" create ${SERVICE} binPath= "\"$INSTDIR\FlowDineOS.PrintAgent.Service.exe\"" start= delayed-auto obj= "${SERVICE_ACCOUNT}" DisplayName= "${PRODUCT}"'
  ${EndIf}
  Pop $0
  ${If} $0 != 0
    Call Rollback
    MessageBox MB_ICONSTOP "The Windows service could not be registered (sc.exe exit $0)." /SD IDOK
    Abort
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\sc.exe" description ${SERVICE} "FlowDineOS local printing agent for restaurant printers."'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\sc.exe" failure ${SERVICE} reset= 86400 actions= restart/5000/restart/30000/restart/60000'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\sc.exe" failureflag ${SERVICE} 1'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\sc.exe" sidtype ${SERVICE} unrestricted'
  Pop $0

  ; 6. Data folder permissions: only SYSTEM, Administrators and the service account (inherited by every file in it).
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$DataDir" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${SERVICE_ACCOUNT}:(OI)(CI)M" /T /Q'
  Pop $0
  ${If} $0 != 0
    Call Rollback
    MessageBox MB_ICONSTOP "The data folder permissions could not be set (icacls exit $0)." /SD IDOK
    Abort
  ${EndIf}

  ; 7. Pair now if a code was given (written into the protected data folder).
  ${If} $PairingCode != ""
    DetailPrint "Pairing with $ServerUrl"
    nsExec::ExecToLog '"$INSTDIR\FlowDineOS.PrintAgent.exe" pair "$PairingCode" --server "$ServerUrl"'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONEXCLAMATION "Pairing did not succeed (the code may have expired). The agent is installed; pair it later with:$\r$\n$\"$INSTDIR\FlowDineOS.PrintAgent.exe$\" pair <CODE>" /SD IDOK
    ${EndIf}
  ${EndIf}

  ; 8. Start, and roll back if the service does not start.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start ${SERVICE}'
  Pop $0
  Sleep 3000
  nsExec::ExecToStack '"$SYSDIR\sc.exe" query ${SERVICE}'
  Pop $0
  Pop $1
  Push $1
  Push "RUNNING"
  Call StrContains
  Pop $2
  ${If} $2 != 1
    Call Rollback
    MessageBox MB_ICONSTOP "The service did not start. The previous version was restored. See $DataDir\logs\agent.log." /SD IDOK
    Abort
  ${EndIf}
  Delete "$INSTDIR\*.rollback"

  ; 9. Uninstaller and Apps & features entry.
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "FlowDineOS"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\FlowDineOS.PrintAgent.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 0
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "EstimatedSize" $0
  DetailPrint "${PRODUCT} ${VERSION} is installed and running."
SectionEnd

Function Rollback
  DetailPrint "Rolling back"
  IfFileExists "$INSTDIR\FlowDineOS.PrintAgent.exe.rollback" 0 done
    Delete "$INSTDIR\FlowDineOS.PrintAgent.exe"
    Delete "$INSTDIR\FlowDineOS.PrintAgent.Service.exe"
    Rename "$INSTDIR\FlowDineOS.PrintAgent.exe.rollback" "$INSTDIR\FlowDineOS.PrintAgent.exe"
    Rename "$INSTDIR\FlowDineOS.PrintAgent.Service.exe.rollback" "$INSTDIR\FlowDineOS.PrintAgent.Service.exe"
    nsExec::ExecToLog '"$SYSDIR\sc.exe" start ${SERVICE}'
    Pop $0
  done:
FunctionEnd

; ── Uninstall ──

Function un.onInit
  SetRegView 64
  StrCpy $DataDir "$COMMONPROGRAMDATA\FlowDineOS\PrintAgent"
  StrCpy $Purge 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/PURGE" $1
  ${IfNot} ${Errors}
    StrCpy $Purge 1
  ${EndIf}
FunctionEnd

Function un.PurgePage
  !insertmacro MUI_HEADER_TEXT "Uninstall ${PRODUCT}" "The service and program files will be removed."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "This computer's pairing is kept, so reinstalling needs no new pairing code. Remove it only if this PC will no longer print for the restaurant (then also revoke the agent in FlowDineOS)."
  Pop $0
  ${NSD_CreateCheckbox} 0 40u 100% 12u "Also remove this PC's pairing and print history"
  Pop $PurgeBox
  nsDialogs::Show
FunctionEnd

Function un.PurgePageLeave
  ${NSD_GetState} $PurgeBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $Purge 1
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop ${SERVICE}'
  Pop $0
  Sleep 5000
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete ${SERVICE}'
  Pop $0
  Delete "$INSTDIR\FlowDineOS.PrintAgent.exe"
  Delete "$INSTDIR\FlowDineOS.PrintAgent.Service.exe"
  Delete "$INSTDIR\*.rollback"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  ${If} $Purge == 1
    DetailPrint "Removing pairing, journal and logs in $DataDir"
    RMDir /r "$DataDir"
  ${Else}
    DetailPrint "Kept $DataDir (pairing and print history)."
  ${EndIf}
SectionEnd
