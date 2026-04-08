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
fn build_seccomp_filter(restrict_network: bool) -> Result<Vec<u8>> {
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
