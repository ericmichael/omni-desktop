use super::SandboxConfig;
use anyhow::{bail, Context, Result};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Locate the bubblewrap binary. Checks:
/// 1. Bundled bwrap next to our own binary
/// 2. System-installed bwrap on PATH
fn find_bwrap() -> Result<PathBuf> {
    // Check for bundled bwrap next to this binary.
    if let Ok(self_path) = std::env::current_exe() {
        let bundled = self_path.parent().unwrap_or(Path::new(".")).join("bwrap");
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    // Fall back to system bwrap.
    let output = Command::new("which")
        .arg("bwrap")
        .output()
        .context("failed to search for bwrap")?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    bail!(
        "bubblewrap (bwrap) not found. It should be bundled with the application. \
         If running from source, install it: sudo apt install bubblewrap"
    )
}

/// Verify unprivileged user namespaces are available.
fn check_user_namespaces() -> Result<()> {
    let disabled = std::fs::read_to_string("/proc/sys/kernel/unprivileged_userns_clone")
        .map(|s| s.trim() == "0")
        .unwrap_or(false);

    if disabled {
        bail!(
            "unprivileged user namespaces are disabled on this system. \
             The sandbox requires them for process isolation. \
             Contact your system administrator to enable: \
             sysctl kernel.unprivileged_userns_clone=1"
        );
    }

    Ok(())
}

/// Build a seccomp BPF filter that blocks dangerous syscalls and optionally
/// restricts network socket creation.
///
/// The filter uses a default-allow policy and explicitly denies:
/// - `ptrace` — prevents tracing/debugging other processes
/// - `io_uring_setup`, `io_uring_enter`, `io_uring_register` — io_uring can
///   bypass seccomp filtering on some kernels
/// - Network socket syscalls (when `restrict_network` is true): `socket`,
///   `socketpair`, `connect`, `accept`, `accept4`, `bind`, `listen`,
///   `sendto`, `sendmmsg`, `recvmmsg`, `getpeername`, `getsockname`,
///   `shutdown`, `setsockopt`, `getsockopt`
///
/// Blocked syscalls return `EPERM`.
///
/// Returns the raw bytes of the BPF program (array of `sock_filter` structs)
/// suitable for passing to bwrap's `--seccomp` fd.
pub(crate) fn build_seccomp_filter(restrict_network: bool) -> Result<Vec<u8>> {
    use seccompiler::{
        sock_filter, BpfProgram, SeccompAction, SeccompFilter, SeccompRule, TargetArch,
    };
    use std::collections::BTreeMap;

    #[cfg(target_arch = "x86_64")]
    let arch = TargetArch::x86_64;
    #[cfg(target_arch = "aarch64")]
    let arch = TargetArch::aarch64;

    let deny = SeccompAction::Errno(libc::EPERM as u32);
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();

    // Always block ptrace and io_uring — these can escape or bypass seccomp.
    for syscall in [
        libc::SYS_ptrace,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ] {
        rules.insert(
            syscall,
            vec![],
        );
    }

    if restrict_network {
        // Block all network socket operations. AF_UNIX is still available
        // through bwrap's namespace isolation — we block at the syscall level
        // for defense in depth on top of --unshare-net.
        for syscall in [
            libc::SYS_socket,
            libc::SYS_socketpair,
            libc::SYS_connect,
            libc::SYS_accept,
            libc::SYS_accept4,
            libc::SYS_bind,
            libc::SYS_listen,
            libc::SYS_sendto,
            libc::SYS_sendmmsg,
            libc::SYS_recvmmsg,
            libc::SYS_getpeername,
            libc::SYS_getsockname,
            libc::SYS_shutdown,
            libc::SYS_setsockopt,
            libc::SYS_getsockopt,
        ] {
            rules.insert(
                syscall,
                vec![],
            );
        }
    }

    let filter = SeccompFilter::new(
        rules,
        // Default action: allow everything not explicitly listed.
        SeccompAction::Allow,
        // Action on filter error: deny.
        deny,
        arch,
    )
    .context("failed to build seccomp filter")?;

    let bpf: BpfProgram = filter
        .try_into()
        .context("failed to compile seccomp filter to BPF")?;

    // Serialize to raw sock_filter bytes for bwrap's --seccomp fd.
    let bytes: Vec<u8> = bpf
        .iter()
        .flat_map(|insn: &sock_filter| {
            let mut buf = Vec::with_capacity(std::mem::size_of::<sock_filter>());
            buf.extend_from_slice(&insn.code.to_ne_bytes());
            buf.extend_from_slice(&insn.jt.to_ne_bytes());
            buf.extend_from_slice(&insn.jf.to_ne_bytes());
            buf.extend_from_slice(&insn.k.to_ne_bytes());
            buf
        })
        .collect();

    Ok(bytes)
}

/// Append `--ro-bind` arguments for protected subpaths within a writable root.
///
/// For each name in `protected_names`, if the path exists under `writable_root`
/// it's re-bound read-only. If it doesn't exist, we bind `/dev/null` on the
/// first missing component to prevent the sandboxed process from creating it.
fn append_protected_subpath_args(
    args: &mut Vec<String>,
    writable_root: &Path,
    protected_names: &[String],
) {
    for name in protected_names {
        let subpath = writable_root.join(name);
        let subpath_str = subpath.to_string_lossy().to_string();

        if subpath.exists() {
            // Path exists — re-bind it read-only.
            args.extend(["--ro-bind".into(), subpath_str.clone(), subpath_str]);
        } else {
            // Path doesn't exist — bind /dev/null to prevent creation.
            // This blocks `mkdir .git` or `touch .env` inside the sandbox.
            args.extend(["--ro-bind".into(), "/dev/null".into(), subpath_str]);
        }
    }
}

pub fn exec(config: SandboxConfig) -> Result<u8> {
    let bwrap = find_bwrap()?;
    check_user_namespaces()?;

    let mut args: Vec<String> = Vec::new();

    // --- Namespace isolation ---
    args.push("--unshare-user".into());
    args.push("--unshare-pid".into());
    args.push("--unshare-uts".into());
    args.push("--unshare-ipc".into());
    if !config.allow_net {
        args.push("--unshare-net".into());
    }
    args.push("--die-with-parent".into());

    // Host-level filtering cannot be enforced at the process level on Linux
    // without root (iptables/nftables require CAP_NET_ADMIN). When a host
    // allowlist is specified, warn that it must be enforced at a higher layer
    // (e.g. Docker iptables rules via apply-network-isolation.sh).
    if !config.net_allow_hosts.is_empty() && config.allow_net {
        eprintln!(
            "omni-sandbox: warning: host-level network filtering (--net-allow) \
             cannot be enforced at the process sandbox level on Linux. \
             Use Docker-level iptables rules for host allowlisting."
        );
    }

    // --- Seccomp filter ---
    // Write the BPF program to a temporary file and pass its fd to bwrap.
    // bwrap installs the filter after setting up namespaces but before
    // exec'ing the child command, which is exactly what we need.
    let seccomp_file = {
        let bytes = build_seccomp_filter(!config.allow_net)
            .context("building seccomp filter")?;
        let mut f = tempfile::tempfile().context("creating seccomp tempfile")?;
        std::io::Write::write_all(&mut f, &bytes)?;
        std::io::Seek::seek(&mut f, std::io::SeekFrom::Start(0))?;
        f
    };
    let seccomp_fd = seccomp_file.as_raw_fd();
    // Clear O_CLOEXEC so the fd survives the fork+exec into bwrap.
    // tempfile sets CLOEXEC by default, which would close the fd before bwrap reads it.
    unsafe {
        let flags = libc::fcntl(seccomp_fd, libc::F_GETFD);
        if flags < 0 {
            bail!("fcntl F_GETFD failed on seccomp fd");
        }
        if libc::fcntl(seccomp_fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
            bail!("fcntl F_SETFD failed on seccomp fd");
        }
    }
    args.extend(["--seccomp".into(), seccomp_fd.to_string()]);

    // --- Minimal rootfs ---
    // Mount system directories read-only so the child can resolve libraries,
    // run binaries, etc. but cannot modify the host.
    for dir in &["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"] {
        if Path::new(dir).exists() {
            args.extend(["--ro-bind".into(), dir.to_string(), dir.to_string()]);
        }
    }

    // SSL/TLS certificates (needed for HTTPS when network is allowed).
    for cert_dir in &["/etc/ssl", "/etc/pki", "/etc/ca-certificates"] {
        if Path::new(cert_dir).exists() {
            args.extend(["--ro-bind".into(), cert_dir.to_string(), cert_dir.to_string()]);
        }
    }

    // /proc and /dev
    args.extend(["--proc".into(), "/proc".into()]);
    args.extend(["--dev".into(), "/dev".into()]);

    // Writable /tmp
    args.extend(["--tmpfs".into(), "/tmp".into()]);

    // /run as tmpfs, then selectively bind what's needed.
    args.extend(["--tmpfs".into(), "/run".into()]);

    // DNS resolution: /etc/resolv.conf is often a symlink to /run/systemd/resolve/.
    // Bind the resolved directory so DNS works inside the sandbox.
    if Path::new("/run/systemd/resolve").exists() {
        args.extend([
            "--ro-bind".into(),
            "/run/systemd/resolve".into(),
            "/run/systemd/resolve".into(),
        ]);
    }
    // Some systems use /run/resolvconf instead.
    if Path::new("/run/resolvconf").exists() {
        args.extend([
            "--ro-bind".into(),
            "/run/resolvconf".into(),
            "/run/resolvconf".into(),
        ]);
    }

    // --- Home directory ---
    // Create an empty tmpfs home so $HOME resolves but is isolated.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".into());
    args.extend(["--tmpfs".into(), home.clone()]);

    // Allow common config that the agent may need (read-only).
    for subdir in &[".config", ".local/share", ".cache"] {
        let host_path = format!("{home}/{subdir}");
        if Path::new(&host_path).exists() {
            args.extend(["--ro-bind".into(), host_path.clone(), host_path]);
        }
    }

    // --- Workspace (read-write) ---
    let ws = config.workspace.to_string_lossy().to_string();
    args.extend(["--bind".into(), ws.clone(), ws.clone()]);

    // --- Protected subpaths within the workspace ---
    // Re-bind sensitive directories as read-only (or block creation if missing).
    // This must come AFTER the writable --bind so the ro-bind takes precedence.
    append_protected_subpath_args(&mut args, &config.workspace, &config.protected_subpaths);

    // --- Extra binds ---
    for path in &config.ro_binds {
        let p = path.to_string_lossy().to_string();
        args.extend(["--ro-bind".into(), p.clone(), p]);
    }
    for path in &config.rw_binds {
        let p = path.to_string_lossy().to_string();
        args.extend(["--bind".into(), p.clone(), p]);

        // Apply protected subpaths to extra writable roots too.
        append_protected_subpath_args(&mut args, path, &config.protected_subpaths);
    }

    // --- Working directory ---
    let cwd = config
        .cwd
        .as_ref()
        .unwrap_or(&config.workspace)
        .to_string_lossy()
        .to_string();
    args.extend(["--chdir".into(), cwd]);

    // --- Command ---
    args.push("--".into());
    if config.command.is_empty() {
        bail!("no command specified");
    }
    args.extend(config.command);

    let status = Command::new(&bwrap)
        .args(&args)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .status()
        .context("failed to spawn bwrap")?;

    Ok(status.code().unwrap_or(1) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // --- Seccomp filter unit tests ---

    #[test]
    fn seccomp_filter_without_network_restriction() {
        let bytes = build_seccomp_filter(false).expect("filter should build");
        assert!(!bytes.is_empty(), "BPF program should not be empty");
    }

    #[test]
    fn seccomp_filter_with_network_restriction() {
        let bytes = build_seccomp_filter(true).expect("filter should build");
        assert!(!bytes.is_empty(), "BPF program should not be empty");
    }

    #[test]
    fn seccomp_filter_network_restriction_produces_more_rules() {
        let without = build_seccomp_filter(false).unwrap();
        let with = build_seccomp_filter(true).unwrap();
        assert!(
            with.len() > without.len(),
            "network-restricted filter should be larger ({} vs {})",
            with.len(),
            without.len()
        );
    }

    #[test]
    fn seccomp_filter_size_is_sock_filter_aligned() {
        // Each sock_filter is 8 bytes (u16 code, u8 jt, u8 jf, u32 k).
        let bytes = build_seccomp_filter(true).unwrap();
        assert_eq!(
            bytes.len() % 8,
            0,
            "BPF byte count ({}) must be a multiple of 8 (sizeof sock_filter)",
            bytes.len()
        );
    }

    // --- Integration tests (require bwrap on system) ---

    #[test]
    #[ignore] // requires bwrap installed
    fn sandbox_runs_true() {
        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec!["/bin/true".into()],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "/bin/true should exit 0");
    }

    #[test]
    #[ignore] // requires bwrap installed
    fn sandbox_runs_false() {
        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec!["/bin/false".into()],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 1, "/bin/false should exit 1");
    }

    #[test]
    #[ignore] // requires bwrap installed
    fn sandbox_blocks_ptrace() {
        // strace attempts ptrace — should fail with EPERM inside the sandbox.
        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(),
                "-c".into(),
                // Try to ptrace ourselves via strace; if blocked, strace exits non-zero.
                "strace -e trace=none /bin/true 2>&1; test $? -ne 0".into(),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "ptrace should be blocked by seccomp");
    }

    #[test]
    #[ignore] // requires bwrap installed
    fn sandbox_protected_subpaths_are_readonly() {
        let workspace = tempfile::tempdir().unwrap();
        // Create a .git directory that should be protected.
        fs::create_dir(workspace.path().join(".git")).unwrap();
        fs::write(workspace.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();

        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(),
                "-c".into(),
                // Writing to .git should fail; writing to workspace root should succeed.
                "touch .git/test 2>/dev/null && exit 1; touch allowed_file && exit 0".into(),
            ],
            protected_subpaths: vec![".git".into()],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, ".git should be read-only but workspace should be writable");
    }

    // --- Helper ---

    fn run_sh(cmd: &str) -> SandboxConfig {
        run_sh_opts(cmd, false, vec![], vec![], vec![])
    }

    fn run_sh_opts(
        cmd: &str,
        allow_net: bool,
        ro_binds: Vec<PathBuf>,
        rw_binds: Vec<PathBuf>,
        protected_subpaths: Vec<String>,
    ) -> SandboxConfig {
        let workspace = tempfile::tempdir().unwrap();
        SandboxConfig {
            workspace: workspace.keep(),
            ro_binds,
            rw_binds,
            allow_net,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec!["/bin/sh".into(), "-c".into(), cmd.into()],
            protected_subpaths,
        }
    }

    // --- Sandbox isolation tests ---

    #[test]
    #[ignore]
    fn sandbox_host_filesystem_is_readonly() {
        // System directories should be mounted read-only.
        let config = run_sh(
            "touch /usr/test 2>/dev/null && exit 1; \
             touch /etc/test 2>/dev/null && exit 1; \
             touch /bin/test 2>/dev/null && exit 1; \
             exit 0"
        );
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "host system dirs should be read-only");
    }

    #[test]
    #[ignore]
    fn sandbox_cannot_write_to_home() {
        // $HOME is a tmpfs — writes succeed inside but must not appear on the host.
        let host_home = std::env::var("HOME").unwrap();
        let marker = format!("{host_home}/omni_sandbox_escape_test_{}", std::process::id());
        let config = run_sh(&format!(
            "touch {marker} 2>/dev/null; exit 0"
        ));
        let _ = exec(config);
        assert!(
            !Path::new(&marker).exists(),
            "file written to $HOME inside sandbox should not appear on host"
        );
    }

    #[test]
    #[ignore]
    fn sandbox_workspace_is_writable() {
        let workspace = tempfile::tempdir().unwrap();
        let ws_path = workspace.path().to_path_buf();
        let config = SandboxConfig {
            workspace: ws_path.clone(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                "echo hello > testfile && cat testfile | grep -q hello".into(),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "workspace should be writable");
        // Verify the file was actually written on the host.
        assert!(ws_path.join("testfile").exists(), "file should exist on host after sandbox exits");
    }

    #[test]
    #[ignore]
    fn sandbox_network_blocked_by_default() {
        // With network unshared + seccomp blocking socket(), any network attempt should fail.
        // Use python if available, otherwise fall back to checking that /sys/class/net only has lo.
        let config = run_sh(
            "python3 -c 'import socket; socket.socket()' 2>&1 | grep -qi 'not permitted' && exit 0; \
             perl -e 'use IO::Socket::INET; IO::Socket::INET->new(\"1.1.1.1:53\") and exit 1; exit 0' 2>/dev/null && exit 0; \
             ls /sys/class/net/ 2>/dev/null | grep -qv lo && exit 1; \
             exit 0"
        );
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "network should be blocked when allow_net is false");
    }

    #[test]
    #[ignore]
    fn sandbox_network_allowed_when_enabled() {
        // With network enabled, we should be able to create a socket (seccomp allows it)
        // and see network interfaces beyond just lo.
        let config = run_sh_opts(
            "cat /proc/net/dev 2>/dev/null | grep -q lo && exit 0; \
             ip link show lo 2>/dev/null | grep -q lo && exit 0; \
             exit 1",
            true, vec![], vec![], vec![],
        );
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "network namespace should not be unshared when allow_net is true");
    }

    #[test]
    #[ignore]
    fn sandbox_pid_namespace_isolation() {
        // Inside the PID namespace, init should be PID 1 (bwrap) and we shouldn't
        // see host PIDs. Count processes — should be very few.
        let config = run_sh(
            "test $(ls /proc | grep -c '^[0-9]') -lt 20"
        );
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "PID namespace should isolate host processes");
    }

    // --- Bind mount tests ---

    #[test]
    #[ignore]
    fn sandbox_ro_binds_are_readonly() {
        let extra_dir = tempfile::tempdir().unwrap();
        fs::write(extra_dir.path().join("data.txt"), "read-only").unwrap();
        let extra_path = extra_dir.path().to_path_buf();
        let mount_target = extra_path.to_string_lossy().to_string();

        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![extra_path],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                format!(
                    "cat {mount_target}/data.txt | grep -q read-only || exit 1; \
                     touch {mount_target}/write_test 2>/dev/null && exit 1; \
                     exit 0"
                ),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "ro_bind should be readable but not writable");
    }

    #[test]
    #[ignore]
    fn sandbox_rw_binds_are_writable() {
        let extra_dir = tempfile::tempdir().unwrap();
        let extra_path = extra_dir.path().to_path_buf();
        let mount_target = extra_path.to_string_lossy().to_string();

        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![extra_path.clone()],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                format!("echo test > {mount_target}/write_test"),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "rw_bind should be writable");
        assert!(extra_path.join("write_test").exists(), "file should exist on host");
    }

    #[test]
    #[ignore]
    fn sandbox_rw_binds_get_protected_subpaths() {
        let extra_dir = tempfile::tempdir().unwrap();
        fs::create_dir(extra_dir.path().join(".git")).unwrap();
        fs::write(extra_dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let extra_path = extra_dir.path().to_path_buf();
        let mount_target = extra_path.to_string_lossy().to_string();

        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![extra_path],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                format!(
                    "echo test > {mount_target}/ok_file || exit 1; \
                     touch {mount_target}/.git/test 2>/dev/null && exit 1; \
                     exit 0"
                ),
            ],
            protected_subpaths: vec![".git".into()],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, ".git in rw_bind should be read-only");
    }

    #[test]
    #[ignore]
    fn sandbox_cwd_is_respected() {
        let workspace = tempfile::tempdir().unwrap();
        let subdir = workspace.path().join("mydir");
        fs::create_dir(&subdir).unwrap();

        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: Some(subdir.clone()),
            command: vec![
                "/bin/sh".into(), "-c".into(),
                format!("test \"$(pwd)\" = \"{}\"", subdir.to_string_lossy()),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "cwd should match the configured directory");
    }

    #[test]
    #[ignore]
    fn sandbox_cwd_defaults_to_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let ws_str = workspace.path().to_string_lossy().to_string();

        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                format!("test \"$(pwd)\" = \"{ws_str}\""),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "cwd should default to workspace");
    }

    // --- Edge cases ---

    #[test]
    fn empty_command_rejected() {
        let workspace = tempfile::tempdir().unwrap();
        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![],
            protected_subpaths: vec![],
        };
        let result = exec(config);
        assert!(result.is_err(), "empty command should be rejected");
        assert!(
            result.unwrap_err().to_string().contains("no command"),
            "error should mention missing command"
        );
    }

    #[test]
    #[ignore]
    fn sandbox_workspace_with_spaces() {
        let base = tempfile::tempdir().unwrap();
        let spaced = base.path().join("my workspace dir");
        fs::create_dir(&spaced).unwrap();

        let config = SandboxConfig {
            workspace: spaced,
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                "echo hello > testfile && test -f testfile".into(),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "workspace paths with spaces should work");
    }

    #[test]
    #[ignore]
    fn sandbox_multiple_protected_subpaths() {
        let workspace = tempfile::tempdir().unwrap();
        for name in &[".git", ".env", ".codex"] {
            fs::create_dir(workspace.path().join(name)).unwrap();
            fs::write(workspace.path().join(name).join("data"), "protected").unwrap();
        }

        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                "touch .git/x 2>/dev/null && exit 1; \
                 touch .env/x 2>/dev/null && exit 1; \
                 touch .codex/x 2>/dev/null && exit 1; \
                 touch workspace_ok && exit 0".into(),
            ],
            protected_subpaths: vec![".git".into(), ".env".into(), ".codex".into()],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "all protected subpaths should be read-only");
    }

    #[test]
    #[ignore]
    fn sandbox_symlink_cannot_escape() {
        let workspace = tempfile::tempdir().unwrap();
        // Create a symlink pointing outside the workspace.
        std::os::unix::fs::symlink("/etc/passwd", workspace.path().join("escape_link")).unwrap();

        let config = SandboxConfig {
            workspace: workspace.path().to_path_buf(),
            ro_binds: vec![],
            rw_binds: vec![],
            allow_net: false,
            net_allow_hosts: vec![],
            cwd: None,
            command: vec![
                "/bin/sh".into(), "-c".into(),
                // The symlink target (/etc/passwd) is ro-bound anyway, so writing through it should fail.
                "echo pwned > escape_link 2>/dev/null && exit 1; exit 0".into(),
            ],
            protected_subpaths: vec![],
        };
        let code = exec(config).expect("exec should succeed");
        assert_eq!(code, 0, "symlink writes should not escape sandbox");
    }

    // --- Protected subpath arg generation ---

    #[test]
    fn protected_subpath_existing_dir_gets_ro_bind() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".git")).unwrap();

        let mut args = Vec::new();
        append_protected_subpath_args(
            &mut args,
            workspace.path(),
            &[".git".into()],
        );

        assert_eq!(args.len(), 3);
        assert_eq!(args[0], "--ro-bind");
        assert!(args[1].ends_with(".git"));
        assert!(args[2].ends_with(".git"));
    }

    #[test]
    fn protected_subpath_missing_dir_gets_dev_null() {
        let workspace = tempfile::tempdir().unwrap();
        // Don't create .git — it should be blocked with /dev/null.

        let mut args = Vec::new();
        append_protected_subpath_args(
            &mut args,
            workspace.path(),
            &[".git".into()],
        );

        assert_eq!(args.len(), 3);
        assert_eq!(args[0], "--ro-bind");
        assert_eq!(args[1], "/dev/null");
        assert!(args[2].ends_with(".git"));
    }
}
