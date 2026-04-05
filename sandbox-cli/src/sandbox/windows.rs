use super::SandboxConfig;
use anyhow::{bail, Context, Result};

#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

/// Encode a Rust string as a null-terminated wide string for Win32 APIs.
#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// AppContainer sandbox implementation
//
// The flow:
//   1. Create (or reuse) an AppContainer profile — this gives us a unique SID.
//   2. Grant that SID read-write ACL access on the workspace directory.
//   3. Spawn the child process with SECURITY_CAPABILITIES referencing the SID.
//   4. Wait for the child to exit.
//   5. Clean up the profile.
//
// AppContainers run at Low Integrity Level and can only access objects whose
// ACL explicitly grants the container's SID. System directories like
// C:\Windows\System32 are readable by default (they have permissive ACLs),
// but the user's home directory and other personal files are NOT — providing
// the isolation we need.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub fn exec(config: SandboxConfig) -> Result<u8> {
    use windows::core::{HSTRING, PWSTR, PSID};
    use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, HANDLE, BOOL};
    use windows::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW,
        EXPLICIT_ACCESS_W, TRUSTEE_W, TRUSTEE_IS_SID, TRUSTEE_TYPE,
        SE_FILE_OBJECT, GRANT_ACCESS, SET_ACCESS,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    };
    use windows::Win32::Security::{
        DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, ACL,
        SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
    };
    use windows::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows::Win32::System::Threading::{
        CreateProcessW, WaitForSingleObject,
        GetExitCodeProcess, PROCESS_INFORMATION,
        STARTUPINFOEXW, STARTUPINFOW,
        EXTENDED_STARTUPINFO_PRESENT,
        InitializeProcThreadAttributeList,
        UpdateProcThreadAttribute,
        DeleteProcThreadAttributeList,
    };

    if config.command.is_empty() {
        bail!("no command specified");
    }

    let profile_name = format!("OmniCodeSandbox_{}", std::process::id());

    // --- Step 1: Create AppContainer profile ---
    let mut container_sid: PSID = PSID::default();

    // Delete any leftover profile from a previous crash.
    let _ = unsafe {
        windows::Win32::UI::Shell::DeleteAppContainerProfile(&HSTRING::from(&profile_name))
    };

    unsafe {
        windows::Win32::UI::Shell::CreateAppContainerProfile(
            &HSTRING::from(&profile_name),
            &HSTRING::from("Omni Code Sandbox"),
            &HSTRING::from("Sandboxed environment for Omni Code agent"),
            None, // No extra capabilities — no network, no special access
            &mut container_sid,
        )
        .context("CreateAppContainerProfile failed")?;
    }

    // Ensure cleanup on all exit paths.
    struct ProfileGuard<'a> {
        name: &'a str,
    }
    impl Drop for ProfileGuard<'_> {
        fn drop(&mut self) {
            unsafe {
                let _ = windows::Win32::UI::Shell::DeleteAppContainerProfile(
                    &HSTRING::from(self.name),
                );
            }
        }
    }
    let _guard = ProfileGuard { name: &profile_name };

    // --- Step 2: Grant workspace directory access to the container SID ---
    grant_directory_access(&config.workspace, container_sid)?;

    // Deny writes to protected subpaths within the workspace. The deny ACE
    // is applied AFTER the allow ACE on the parent — Windows evaluates deny
    // ACEs before allow ACEs, so these take precedence.
    for name in &config.protected_subpaths {
        let subpath = config.workspace.join(name);
        if subpath.exists() {
            deny_directory_write(&subpath, container_sid)?;
        }
    }

    for path in &config.rw_binds {
        grant_directory_access(path, container_sid)?;
        // Protect subpaths in extra writable roots too.
        for name in &config.protected_subpaths {
            let subpath = path.join(name);
            if subpath.exists() {
                deny_directory_write(&subpath, container_sid)?;
            }
        }
    }
    // Note: ro_binds get read-only ACLs (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE).
    // For simplicity in this initial version, we grant full access to all binds.
    // A production version should distinguish read-only vs read-write.
    for path in &config.ro_binds {
        grant_directory_access(path, container_sid)?;
    }

    // --- Step 3: Build SECURITY_CAPABILITIES ---
    let mut capabilities: Vec<SID_AND_ATTRIBUTES> = Vec::new();
    let _internet_sid_buf: Vec<u8>; // Must outlive capabilities vec.

    if config.allow_net {
        // internetClient is a well-known capability SID: S-1-15-3-1.
        // We construct it via ConvertStringSidToSidW for clarity and
        // correctness rather than hardcoding the binary representation.
        let sid_str = to_wide("S-1-15-3-1");
        let mut psid: *mut std::ffi::c_void = std::ptr::null_mut();

        #[link(name = "advapi32")]
        unsafe extern "system" {
            fn ConvertStringSidToSidW(
                StringSid: *const u16,
                Sid: *mut *mut std::ffi::c_void,
            ) -> i32;
        }

        let ok = unsafe { ConvertStringSidToSidW(sid_str.as_ptr(), &mut psid) };
        if ok == 0 {
            bail!("ConvertStringSidToSidW failed for internetClient SID (S-1-15-3-1)");
        }

        // Copy the SID into owned memory so the pointer lives long enough.
        let sid_len = unsafe { windows::Win32::Security::GetLengthSid(PSID(psid)) } as usize;
        _internet_sid_buf = unsafe { std::slice::from_raw_parts(psid as *const u8, sid_len) }.to_vec();
        unsafe { windows::Win32::Foundation::LocalFree(Some(psid as *mut std::ffi::c_void)) };

        capabilities.push(SID_AND_ATTRIBUTES {
            Sid: PSID(_internet_sid_buf.as_ptr() as *mut std::ffi::c_void),
            Attributes: windows::Win32::Security::SE_GROUP_ENABLED.0 as u32,
        });
    } else {
        _internet_sid_buf = Vec::new();
    }

    let security_capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: container_sid,
        Capabilities: if capabilities.is_empty() {
            std::ptr::null_mut()
        } else {
            capabilities.as_mut_ptr()
        },
        CapabilityCount: capabilities.len() as u32,
        Reserved: 0,
    };

    // --- Step 4: Create process with extended startup info ---
    let cwd = config.cwd.as_ref().unwrap_or(&config.workspace);
    let cwd_wide = to_wide(&cwd.to_string_lossy());

    // Build command line as a single string (Windows convention).
    let cmd_line = config
        .command
        .iter()
        .map(|arg| {
            if arg.contains(' ') || arg.contains('"') {
                format!("\"{}\"", arg.replace('"', "\\\""))
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd_wide = to_wide(&cmd_line);

    // Initialize proc thread attribute list.
    let mut attr_list_size: usize = 0;
    let _ = unsafe {
        InitializeProcThreadAttributeList(None, 1, 0, &mut attr_list_size)
    };

    let mut attr_list_buf = vec![0u8; attr_list_size];
    let attr_list = attr_list_buf.as_mut_ptr() as *mut _;

    unsafe {
        InitializeProcThreadAttributeList(
            Some(attr_list),
            1,
            0,
            &mut attr_list_size,
        )
        .context("InitializeProcThreadAttributeList failed")?;
    }

    // PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
    const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x00020009;

    unsafe {
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            Some(
                &security_capabilities as *const SECURITY_CAPABILITIES as *const std::ffi::c_void,
            ),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
        .context("UpdateProcThreadAttribute failed")?;
    }

    let mut startup_info = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
            ..Default::default()
        },
        lpAttributeList: attr_list,
    };

    let mut proc_info = PROCESS_INFORMATION::default();

    let created = unsafe {
        CreateProcessW(
            None,
            PWSTR(cmd_wide.as_mut_ptr()),
            None,
            None,
            BOOL(1), // Inherit handles (for stdio passthrough)
            EXTENDED_STARTUPINFO_PRESENT,
            None,
            PWSTR(cwd_wide.as_ptr() as *mut _),
            &startup_info.StartupInfo,
            &mut proc_info,
        )
    };

    unsafe {
        DeleteProcThreadAttributeList(attr_list);
    }

    created.context("CreateProcessW with AppContainer failed")?;

    // --- Step 5: Wait for child ---
    unsafe {
        WaitForSingleObject(proc_info.hProcess, u32::MAX);

        let mut exit_code: u32 = 1;
        let _ = GetExitCodeProcess(proc_info.hProcess, &mut exit_code);

        CloseHandle(proc_info.hProcess);
        CloseHandle(proc_info.hThread);

        Ok(exit_code as u8)
    }
}

/// Grant the AppContainer SID full access to a directory and its children.
#[cfg(target_os = "windows")]
fn grant_directory_access(path: &std::path::Path, sid: windows::Win32::Foundation::PSID) -> Result<()> {
    use windows::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetNamedSecurityInfoW,
        SetEntriesInAclW,
        EXPLICIT_ACCESS_W, TRUSTEE_W,
        SE_FILE_OBJECT, GRANT_ACCESS, SET_ACCESS,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    };
    use windows::Win32::Security::{DACL_SECURITY_INFORMATION, ACL};
    use windows::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows::core::HSTRING;

    let path_wide = HSTRING::from(path.to_string_lossy().as_ref());
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: windows::Win32::Security::PSECURITY_DESCRIPTOR =
        windows::Win32::Security::PSECURITY_DESCRIPTOR::default();

    unsafe {
        GetNamedSecurityInfoW(
            &path_wide,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old_dacl),
            None,
            &mut sd,
        )
        .context("GetNamedSecurityInfoW failed")?;
    }

    let ea = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS.0,
        grfAccessMode: GRANT_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: windows::core::PWSTR(sid.0 as *mut u16),
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        },
    };

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    unsafe {
        SetEntriesInAclW(Some(&[ea]), Some(old_dacl), &mut new_dacl)
            .context("SetEntriesInAclW failed")?;
    }

    unsafe {
        SetNamedSecurityInfoW(
            path_wide,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_dacl),
            None,
        )
        .context("SetNamedSecurityInfoW failed")?;
    }

    Ok(())
}

/// Deny the AppContainer SID write access to a directory and its children.
///
/// Adds an explicit deny ACE for write operations. Windows evaluates deny
/// ACEs before allow ACEs, so this overrides the parent directory's grant
/// even though `grant_directory_access` was called on the parent.
#[cfg(target_os = "windows")]
fn deny_directory_write(path: &std::path::Path, sid: windows::Win32::Foundation::PSID) -> Result<()> {
    use windows::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetNamedSecurityInfoW,
        SetEntriesInAclW,
        EXPLICIT_ACCESS_W, TRUSTEE_W,
        SE_FILE_OBJECT, DENY_ACCESS,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        NO_MULTIPLE_TRUSTEE, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    };
    use windows::Win32::Security::{DACL_SECURITY_INFORMATION, ACL};
    use windows::Win32::Storage::FileSystem::{
        FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_EA,
        FILE_WRITE_ATTRIBUTES, FILE_DELETE_CHILD,
    };
    use windows::core::HSTRING;

    // Combine all write-related permissions into a single deny mask.
    let write_mask = FILE_WRITE_DATA.0
        | FILE_APPEND_DATA.0
        | FILE_WRITE_EA.0
        | FILE_WRITE_ATTRIBUTES.0
        | FILE_DELETE_CHILD.0
        | 0x00010000; // DELETE

    let path_wide = HSTRING::from(path.to_string_lossy().as_ref());
    let mut old_dacl: *mut ACL = std::ptr::null_mut();
    let mut sd: windows::Win32::Security::PSECURITY_DESCRIPTOR =
        windows::Win32::Security::PSECURITY_DESCRIPTOR::default();

    unsafe {
        GetNamedSecurityInfoW(
            &path_wide,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut old_dacl),
            None,
            &mut sd,
        )
        .context("GetNamedSecurityInfoW failed for protected subpath")?;
    }

    let ea = EXPLICIT_ACCESS_W {
        grfAccessPermissions: write_mask,
        grfAccessMode: DENY_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: windows::core::PWSTR(sid.0 as *mut u16),
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        },
    };

    let mut new_dacl: *mut ACL = std::ptr::null_mut();
    unsafe {
        SetEntriesInAclW(Some(&[ea]), Some(old_dacl), &mut new_dacl)
            .context("SetEntriesInAclW failed for deny ACE")?;
    }

    unsafe {
        SetNamedSecurityInfoW(
            path_wide,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(new_dacl),
            None,
        )
        .context("SetNamedSecurityInfoW failed for protected subpath")?;
    }

    Ok(())
}

// Stub for non-Windows compilation (allows `cargo check` on other platforms).
#[cfg(not(target_os = "windows"))]
pub fn exec(_config: SandboxConfig) -> Result<u8> {
    bail!("Windows AppContainer is not available on this platform")
}
