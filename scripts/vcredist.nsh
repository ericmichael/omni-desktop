; Included by electron-builder's NSIS installer.
; Defines the customInstall macro which is called automatically after file extraction.
; Downloads and installs the VC++ 2015-2022 Redistributable (x64) if not already present.
; Uses the inetc plugin (bundled with electron-builder's NSIS).
; Uses ShellExecAsUser with "runas" verb so only the VC++ step requests UAC elevation,
; keeping the Omni installer itself per-user (no admin required).

!macro customInstall
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
  ${If} $0 >= 14
    DetailPrint "Visual C++ Redistributable already installed (v$0), skipping."
  ${Else}
    DetailPrint "Downloading Visual C++ Redistributable..."
    inetc::get /USERAGENT "Omni Code Installer" /RESUME "" "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$PLUGINSDIR\vc_redist.x64.exe" /END
    Pop $0 ; status
    ${If} $0 == "OK"
      DetailPrint "Installing Visual C++ Redistributable (you may see a UAC prompt)..."
      ExecShell "runas" '"$PLUGINSDIR\vc_redist.x64.exe"' "/install /quiet /norestart" SW_HIDE
    ${Else}
      DetailPrint "Failed to download Visual C++ Redistributable ($0). You may need to install it manually."
    ${EndIf}
  ${EndIf}
!macroend
