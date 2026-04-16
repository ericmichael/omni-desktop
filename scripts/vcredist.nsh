; Included by electron-builder's NSIS installer.
; Ensures the VC++ 2015-2022 x64 Redistributable is installed.
;
; Design notes:
;   - `SetRegView 64` before the registry check. NSIS defaults to the 32-bit
;     view, which reads from WOW6432Node and silently misses the x64 redist's
;     registration — causing the install to re-run on every upgrade.
;   - The redistributable is bundled into the installer via `File`. The
;     previous install-time download from aka.ms failed on corporate proxies
;     and offline installs; bundling removes that failure mode.
;   - `ExecShellWait` (not `ExecShell`) so the main installer waits for the
;     elevated redist install to finish before continuing. Otherwise the app
;     could be launched before msvcp140.dll / vcruntime140.dll are available.
;   - Re-reads the registry after the install to confirm it actually worked.
;     `ExecShellWait` has no straightforward way to surface the child exit
;     code, so the registry is our source of truth. If the user cancels UAC
;     or the install fails, we show a clear MessageBox.

!macro customInstall
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
  SetRegView 32

  ${If} $0 >= 14
    DetailPrint "Visual C++ Redistributable already installed (v$0), skipping."
  ${Else}
    DetailPrint "Installing Visual C++ Redistributable (you may see a UAC prompt)..."
    SetOutPath "$PLUGINSDIR"
    File "/oname=vc_redist.x64.exe" "${PROJECT_DIR}\assets\bin\vc_redist.x64.exe"
    ExecShellWait "runas" '"$PLUGINSDIR\vc_redist.x64.exe"' "/install /quiet /norestart" SW_HIDE

    ; Verify by re-reading the registry. ExecShellWait doesn't expose the
    ; child exit code, so this is our only honest signal of success.
    SetRegView 64
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
    SetRegView 32

    ${If} $0 >= 14
      DetailPrint "Visual C++ Redistributable installed successfully."
    ${Else}
      DetailPrint "Visual C++ Redistributable install did not complete."
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "Omni Code requires the Microsoft Visual C++ 2015-2022 Redistributable.$\r$\n$\r$\n\
The installer was unable to install it (the UAC prompt may have been declined, or your account lacks admin rights).$\r$\n$\r$\n\
Omni Code will still be installed, but it may fail to launch until the redistributable is installed. You can download it from:$\r$\n$\r$\n\
https://aka.ms/vs/17/release/vc_redist.x64.exe"
    ${EndIf}
  ${EndIf}
!macroend
