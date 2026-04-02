; ---------------------------------------------------------------------------
; Rattin NSIS Installer
;
; Builds a Windows installer from the assembled distribution directory.
; Invoked by build-windows.ps1 or CI:
;   makensis /DVERSION=2.4.5 /DDIST_DIR=path\to\dist /DOUTPUT=Rattin-Setup.exe rattin.nsi
; ---------------------------------------------------------------------------

!ifndef VERSION
    !define VERSION "0.0.0"
!endif
!ifndef DIST_DIR
    !error "DIST_DIR must be defined (path to assembled Rattin directory)"
!endif
!ifndef OUTPUT
    !define OUTPUT "Rattin-x64-Setup.exe"
!endif

!searchparse "${VERSION}" `` VERSION_MAJOR `.` VERSION_MINOR `.` VERSION_PATCH

Name "Rattin ${VERSION}"
Caption "Rattin ${VERSION} - Installer"
BrandingText "Rattin ${VERSION}"
VIAddVersionKey "ProductName" "Rattin"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "Rattin ${VERSION} Installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIProductVersion "${VERSION}.0"

!define MUI_ICON "${DIST_DIR}\rattin.ico"
!define MUI_UNICON "${DIST_DIR}\rattin.ico"
OutFile "${OUTPUT}"
Unicode True
SetCompressor lzma
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Rattin"
InstallDirRegKey HKCU "Software\Rattin" "InstallDir"

!define APP_EXE "rattin-shell.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin"

; ---------------------------------------------------------------------------
; Includes
; ---------------------------------------------------------------------------
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "nsProcess.nsh"
!include "fileassoc.nsh"

; ---------------------------------------------------------------------------
; Finish page customization
; ---------------------------------------------------------------------------
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(desktopShortcut)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION finishpageaction

; ---------------------------------------------------------------------------
; Pages
; ---------------------------------------------------------------------------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_SHOW fin_pg_options
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE fin_pg_leave
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------
; Localization
; ---------------------------------------------------------------------------
LangString desktopShortcut ${LANG_ENGLISH} "Desktop Shortcut"
LangString appIsRunning ${LANG_ENGLISH} "Rattin is running. Do you want to close it?"
LangString appIsRunningInstallError ${LANG_ENGLISH} "Rattin cannot be installed while another instance is running."
LangString appIsRunningUninstallError ${LANG_ENGLISH} "Rattin cannot be uninstalled while another instance is running."

; ---------------------------------------------------------------------------
; Variables
; ---------------------------------------------------------------------------
Var Parameters
Var AssociateTorrentCheckbox
Var TorrentCheckboxValue

; ---------------------------------------------------------------------------
; Process management macro
; ---------------------------------------------------------------------------
!macro checkIfAppIsRunning AppIsRunningErrorMsg
    ${nsProcess::FindProcess} "${APP_EXE}" $R0

    ${If} $R0 == 0
        IfSilent killapp
        MessageBox MB_YESNO|MB_ICONQUESTION "$(appIsRunning)" IDYES killapp
        ; Re-check — user might have closed it manually
        ${nsProcess::FindProcess} "${APP_EXE}" $R0
        ${If} $R0 == 0
            Abort "${AppIsRunningErrorMsg}"
        ${EndIf}
        Goto done
        killapp:
        ${nsProcess::KillProcess} "${APP_EXE}" $R0
        Sleep 2000
    ${EndIf}
    done:

    ${nsProcess::Unload}
!macroend

; ---------------------------------------------------------------------------
; Finish page: torrent association checkbox
; ---------------------------------------------------------------------------
Function fin_pg_options
    ${NSD_CreateCheckbox} 180 -100 100% 8u "Associate Rattin with .torrent files"
    Pop $AssociateTorrentCheckbox
    ${NSD_Check} $AssociateTorrentCheckbox
FunctionEnd

Function fin_pg_leave
    ${NSD_GetState} $AssociateTorrentCheckbox $TorrentCheckboxValue
    IfSilent 0 assoc
    ; Silent mode: associate by default unless /notorrentassoc
    StrCpy $TorrentCheckboxValue ${BST_UNCHECKED}
    ${GetParameters} $Parameters
    ClearErrors
    ${GetOptions} $Parameters /notorrentassoc $R1
    IfErrors 0 assoc
    StrCpy $TorrentCheckboxValue ${BST_CHECKED}
    assoc:
    ${If} $TorrentCheckboxValue == ${BST_CHECKED}
        !insertmacro APP_ASSOCIATE "torrent" "rattin.torrent" "BitTorrent file" \
            "$INSTDIR\${APP_EXE},0" "Play with Rattin" "$INSTDIR\${APP_EXE} $\"%1$\""
        !insertmacro UPDATEFILEASSOC
    ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; Finish page: desktop shortcut
; ---------------------------------------------------------------------------
Function finishpageaction
    CreateShortCut "$DESKTOP\Rattin.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\rattin.ico" "" "" "" "Rattin ${VERSION}"
FunctionEnd

; ---------------------------------------------------------------------------
; Init
; ---------------------------------------------------------------------------
Function .onInit
    ${GetParameters} $Parameters
FunctionEnd

; ---------------------------------------------------------------------------
; Install section
; ---------------------------------------------------------------------------
Section "Install"
    !insertmacro checkIfAppIsRunning "$(appIsRunningInstallError)"

    SetOutPath "$INSTDIR"

    ; Copy all files from dist directory
    File /r "${DIST_DIR}\*.*"

    ; Write registry keys
    WriteRegStr HKCU "Software\Rattin" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Rattin" "Version" "${VERSION}"

    ; Uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; Add/Remove Programs entry
    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Rattin"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\rattin.ico"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Rattin"
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

    ; Start Menu shortcut
    CreateDirectory "$SMPROGRAMS\Rattin"
    CreateShortcut "$SMPROGRAMS\Rattin\Rattin.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\rattin.ico"
    CreateShortcut "$SMPROGRAMS\Rattin\Uninstall Rattin.lnk" "$INSTDIR\uninstall.exe"

    ; Silent mode: create desktop shortcut unless /nodesktopicon
    IfSilent 0 end
    ${GetOptions} $Parameters /nodesktopicon $R1
    IfErrors 0 end
    Call finishpageaction
    end:
SectionEnd

; ---------------------------------------------------------------------------
; Uninstall section
; ---------------------------------------------------------------------------
Section "Uninstall"
    !insertmacro checkIfAppIsRunning "$(appIsRunningUninstallError)"

    ; Remove files
    RMDir /r "$INSTDIR"

    ; Remove Start Menu shortcuts
    RMDir /r "$SMPROGRAMS\Rattin"

    ; Remove desktop shortcut
    Delete "$DESKTOP\Rattin.lnk"

    ; Remove registry keys
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    DeleteRegKey HKCU "Software\Rattin"

    ; Remove torrent association
    !insertmacro APP_UNASSOCIATE "torrent" "rattin.torrent"
SectionEnd
