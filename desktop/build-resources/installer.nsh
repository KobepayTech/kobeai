; installer.nsh — included by electron-builder into its generated NSIS script.
; electron-builder already handles pages, shortcuts, upgrades and uninstall
; registration; this only adds what a LAN school server needs.
!include "LogicLib.nsh"

; Microsoft's registry key for the VC++ 2015-2022 x64 runtime ("Installed"=1).
!define VCREDIST_KEY "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64"
!define K9_FIREWALL_RULE "K9 School Server"
; Keep in sync with K9_PORT in electron/main.cjs.
!define K9_PORT "8088"

!macro customInstall
  ; ── 1. Visual C++ runtime (needed by the bundled PostgreSQL) ───────────────
  ReadRegDWORD $0 HKLM "${VCREDIST_KEY}" "Installed"
  ${If} $0 != "1"
    DetailPrint "Installing Visual C++ 2015-2022 x64 Redistributable..."
    SetOutPath "$PLUGINSDIR"
    File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1
    ; 1638 = newer version already installed, 3010 = reboot required later.
    ${If} $1 != 0
    ${AndIf} $1 != 1638
    ${AndIf} $1 != 3010
      MessageBox MB_OK|MB_ICONEXCLAMATION "Visual C++ Redistributable setup returned code $1.$\n$\nK9 may not start correctly. Install vc_redist.x64.exe from Microsoft if it fails."
    ${EndIf}
    SetOutPath "$INSTDIR"
  ${Else}
    DetailPrint "Visual C++ 2015-2022 x64 Redistributable already present."
  ${EndIf}

  ; ── 2. Let classroom TVs, Teacher Lens and parents reach K9 on the LAN ────
  DetailPrint "Allowing K9 through Windows Firewall on TCP ${K9_PORT} (private and domain networks)..."
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${K9_FIREWALL_RULE}"'
  Pop $2
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${K9_FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=${K9_PORT} profile=private,domain'
  Pop $2
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${K9_FIREWALL_RULE}"'
  Pop $0
  ; School data in %APPDATA%\K9 School Server is intentionally kept.
!macroend
