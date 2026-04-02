; ---------------------------------------------------------------------------
; Rattin NSIS Installer
;
; Builds a Windows installer from the assembled distribution directory.
; Invoked by build-windows.ps1 or manually:
;   makensis /DVERSION=2.0.0 /DDIST_DIR=path\to\dist /DOUTPUT=Rattin-Setup.exe rattin.nsi
; ---------------------------------------------------------------------------

!ifndef VERSION
    !define VERSION "2.0.0"
!endif
!ifndef DIST_DIR
    !error "DIST_DIR must be defined (path to assembled Rattin directory)"
!endif
!ifndef OUTPUT
    !define OUTPUT "Rattin-x64-Setup.exe"
!endif

Name "Rattin ${VERSION}"
!define MUI_ICON "${DIST_DIR}\rattin.ico"
!define MUI_UNICON "${DIST_DIR}\rattin.ico"
OutFile "${OUTPUT}"
Unicode True
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Rattin"
InstallDirRegKey HKCU "Software\Rattin" "InstallDir"

; ---------------------------------------------------------------------------
; Pages
; ---------------------------------------------------------------------------
!include "MUI2.nsh"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------
; Install section
; ---------------------------------------------------------------------------
Section "Install"
    SetOutPath "$INSTDIR"

    ; Copy all files from dist directory
    File /r "${DIST_DIR}\*.*"

    ; Write registry keys
    WriteRegStr HKCU "Software\Rattin" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Rattin" "Version" "${VERSION}"

    ; Uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; Add/Remove Programs entry
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "DisplayName" "Rattin"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "DisplayIcon" "$INSTDIR\rattin.ico"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "Publisher" "Rattin"
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin" \
        "NoRepair" 1

    ; Start Menu shortcut
    CreateDirectory "$SMPROGRAMS\Rattin"
    CreateShortcut "$SMPROGRAMS\Rattin\Rattin.lnk" "$INSTDIR\rattin-shell.exe" "" "$INSTDIR\rattin.ico"
    CreateShortcut "$SMPROGRAMS\Rattin\Uninstall Rattin.lnk" "$INSTDIR\uninstall.exe"

    ; Optional desktop shortcut
    CreateShortcut "$DESKTOP\Rattin.lnk" "$INSTDIR\rattin-shell.exe" "" "$INSTDIR\rattin.ico"
SectionEnd

; ---------------------------------------------------------------------------
; Uninstall section
; ---------------------------------------------------------------------------
Section "Uninstall"
    ; Remove files
    RMDir /r "$INSTDIR"

    ; Remove Start Menu shortcuts
    RMDir /r "$SMPROGRAMS\Rattin"

    ; Remove desktop shortcut
    Delete "$DESKTOP\Rattin.lnk"

    ; Remove registry keys
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rattin"
    DeleteRegKey HKCU "Software\Rattin"
SectionEnd
