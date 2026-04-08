use super::accel::Accelerator;
use super::VmConfig;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Locate the QEMU system binary.
///
/// Search order:
/// 1. Bundled QEMU next to the omni-sandbox binary.
/// 2. System-installed QEMU on PATH.
pub fn find_binary() -> Result<PathBuf> {
    let binary_name = qemu_binary_name();

    // Check for bundled binary next to our own executable.
    if let Ok(self_path) = std::env::current_exe() {
        let bundled = self_path
            .parent()
            .unwrap_or(Path::new("."))
            .join(&binary_name);
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    // Check PATH.
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(which_cmd)
        .arg(&binary_name)
        .output()
        .with_context(|| format!("failed to search for {binary_name}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            // `where` on Windows may return multiple lines; take the first.
            let first = path.lines().next().unwrap_or(&path);
            return Ok(PathBuf::from(first));
        }
    }

    bail!(
        "{binary_name} not found. Install QEMU:\n  \
         Linux:   sudo apt install qemu-system-x86 (or qemu-system-aarch64)\n  \
         macOS:   brew install qemu\n  \
         Windows: https://www.qemu.org/download/#windows"
    )
}

/// Spawn the QEMU process with the given configuration.
pub fn spawn(qemu_bin: &Path, config: &VmConfig, accel: &Accelerator) -> Result<Child> {
    let args = build_args(config, accel)?;

    eprintln!(
        "omni-sandbox: starting VM ({}MB RAM, {} CPUs, agent port {})",
        config.memory_mb, config.cpus, config.agent_port
    );

    let child = Command::new(qemu_bin)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("failed to spawn QEMU")?;

    Ok(child)
}

/// Build the QEMU command-line arguments.
pub(crate) fn build_args(config: &VmConfig, accel: &Accelerator) -> Result<Vec<String>> {
    let mut args: Vec<String> = Vec::new();

    // Machine type and acceleration.
    let machine = if *accel == Accelerator::Tcg {
        // microvm doesn't have PCI which we need for virtio-net and 9p.
        format!("q35,accel={}", accel.qemu_flag())
    } else {
        format!("q35,accel={}", accel.qemu_flag())
    };
    args.extend(["-machine".into(), machine]);
    args.extend(["-cpu".into(), accel.cpu_flag().into()]);

    // Memory and CPUs.
    args.extend(["-m".into(), format!("{}M", config.memory_mb)]);
    args.extend(["-smp".into(), config.cpus.to_string()]);

    // No graphical display.
    args.push("-nographic".into());

    // Boot: direct kernel boot from extracted kernel + initrd.
    let kernel_path = config.image_dir.join("vmlinuz");
    let initrd_path = config.image_dir.join("initrd.img");
    let rootfs_path = config.image_dir.join("rootfs.ext4");

    if !kernel_path.exists() {
        bail!("kernel not found at {}", kernel_path.display());
    }
    if !initrd_path.exists() {
        bail!("initrd not found at {}", initrd_path.display());
    }
    if !rootfs_path.exists() {
        bail!("rootfs not found at {}", rootfs_path.display());
    }

    args.extend(["-kernel".into(), kernel_path.to_string_lossy().into()]);
    args.extend(["-initrd".into(), initrd_path.to_string_lossy().into()]);

    // Kernel command line: mount root, quiet boot, serial console.
    let append = "root=/dev/vda rw console=ttyS0 quiet loglevel=3";
    args.extend(["-append".into(), append.into()]);

    // Root disk (the rootfs image).
    args.extend([
        "-drive".into(),
        format!(
            "file={},format=raw,if=virtio",
            rootfs_path.to_string_lossy()
        ),
    ]);

    // Workspace sharing via 9p virtio.
    let ws_path = config.workspace.to_string_lossy();
    args.extend([
        "-virtfs".into(),
        format!(
            "local,path={ws_path},mount_tag=workspace,security_model=none,id=ws"
        ),
    ]);

    // Networking: user-mode (no admin needed).
    if config.no_net {
        // Restrict networking completely: use the `restrict=y` option which blocks
        // all outbound traffic except explicitly forwarded ports.
        let netdev = format!(
            "user,id=net0,restrict=y,\
             hostfwd=tcp::{agent}-:7681,\
             hostfwd=tcp::{cs}-:8080,\
             hostfwd=tcp::{vnc}-:6080",
            agent = config.agent_port,
            cs = config.code_server_port,
            vnc = config.vnc_port,
        );
        args.extend(["-netdev".into(), netdev]);
    } else if !config.net_allow.is_empty() {
        // QEMU user-mode networking doesn't support host-level allowlists natively.
        // Allow full outbound (the VM's init script will apply iptables rules using
        // the allowlist, same approach as apply-network-isolation.sh in Docker mode).
        eprintln!(
            "omni-sandbox: network allowlist will be enforced inside the VM via iptables"
        );
        let netdev = format!(
            "user,id=net0,\
             hostfwd=tcp::{agent}-:7681,\
             hostfwd=tcp::{cs}-:8080,\
             hostfwd=tcp::{vnc}-:6080",
            agent = config.agent_port,
            cs = config.code_server_port,
            vnc = config.vnc_port,
        );
        args.extend(["-netdev".into(), netdev]);
    } else {
        // Full outbound internet access + port forwarding.
        let netdev = format!(
            "user,id=net0,\
             hostfwd=tcp::{agent}-:7681,\
             hostfwd=tcp::{cs}-:8080,\
             hostfwd=tcp::{vnc}-:6080",
            agent = config.agent_port,
            cs = config.code_server_port,
            vnc = config.vnc_port,
        );
        args.extend(["-netdev".into(), netdev]);
    }
    args.extend(["-device".into(), "virtio-net-pci,netdev=net0".into()]);

    // QMP monitor socket for graceful shutdown.
    let monitor_sock = config.image_dir.join(format!("qemu-{}.sock", std::process::id()));
    args.extend([
        "-qmp".into(),
        format!(
            "unix:{},server,nowait",
            monitor_sock.to_string_lossy()
        ),
    ]);

    // Serial console on stdio for boot output capture.
    args.extend(["-serial".into(), "stdio".into()]);

    // Don't reboot on kernel panic — just exit.
    args.push("-no-reboot".into());

    // Pass network allowlist as kernel append parameter so the VM init can read it.
    // We use a QEMU fw_cfg device to pass arbitrary data into the VM.
    if !config.net_allow.is_empty() {
        let allowlist = config.net_allow.join(",");
        args.extend([
            "-fw_cfg".into(),
            format!("name=opt/omni/net_allowlist,string={allowlist}"),
        ]);
    }

    Ok(args)
}

/// Return the platform-appropriate QEMU binary name.
pub(crate) fn qemu_binary_name() -> String {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    if cfg!(windows) {
        format!("qemu-system-{arch}.exe")
    } else {
        format!("qemu-system-{arch}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Create a minimal fake image directory with the required files.
    fn fake_image_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("vmlinuz"), "fake-kernel").unwrap();
        fs::write(dir.path().join("initrd.img"), "fake-initrd").unwrap();
        fs::write(dir.path().join("rootfs.ext4"), "fake-rootfs").unwrap();
        dir
    }

    fn test_config(image_dir: &Path, workspace: &Path) -> VmConfig {
        VmConfig {
            workspace: workspace.to_path_buf(),
            memory_mb: 4096,
            cpus: 2,
            agent_port: 7681,
            code_server_port: 8080,
            vnc_port: 6080,
            image_dir: image_dir.to_path_buf(),
            net_allow: vec![],
            no_net: false,
        }
    }

    #[test]
    fn build_args_basic() {
        let img = fake_image_dir();
        let ws = tempfile::tempdir().unwrap();
        let config = test_config(img.path(), ws.path());
        let args = build_args(&config, &Accelerator::Tcg).unwrap();
        let joined = args.join(" ");

        assert!(joined.contains("-machine"), "should have -machine");
        assert!(joined.contains("-m 4096M"), "should set memory");
        assert!(joined.contains("-smp 2"), "should set CPUs");
        assert!(joined.contains("-nographic"), "should be headless");
        assert!(joined.contains("-kernel"), "should have kernel path");
        assert!(joined.contains("-initrd"), "should have initrd path");
        assert!(joined.contains("-drive"), "should have rootfs drive");
        assert!(joined.contains("-virtfs"), "should have 9p workspace mount");
        assert!(joined.contains("-netdev"), "should have network device");
        assert!(joined.contains("-serial stdio"), "should have serial console");
        assert!(joined.contains("-no-reboot"), "should disable reboot on panic");
    }

    #[test]
    fn build_args_accel_flag() {
        let img = fake_image_dir();
        let ws = tempfile::tempdir().unwrap();
        let config = test_config(img.path(), ws.path());

        let args_tcg = build_args(&config, &Accelerator::Tcg).unwrap();
        assert!(args_tcg.iter().any(|a| a.contains("accel=tcg")));

        let args_kvm = build_args(&config, &Accelerator::Kvm).unwrap();
        assert!(args_kvm.iter().any(|a| a.contains("accel=kvm")));
    }

    #[test]
    fn build_args_no_net() {
        let img = fake_image_dir();
        let ws = tempfile::tempdir().unwrap();
        let mut config = test_config(img.path(), ws.path());
        config.no_net = true;

        let args = build_args(&config, &Accelerator::Tcg).unwrap();
        let netdev = args.iter().find(|a| a.starts_with("user,id=net0")).unwrap();
        assert!(netdev.contains("restrict=y"), "no_net should add restrict=y: {netdev}");
    }

    #[test]
    fn build_args_full_net_no_restrict() {
        let img = fake_image_dir();
        let ws = tempfile::tempdir().unwrap();
        let config = test_config(img.path(), ws.path());

        let args = build_args(&config, &Accelerator::Tcg).unwrap();
        let netdev = args.iter().find(|a| a.starts_with("user,id=net0")).unwrap();
        assert!(!netdev.contains("restrict=y"), "full net should not restrict: {netdev}");
        assert!(!args.iter().any(|a| a.contains("-fw_cfg")), "should not have fw_cfg");
    }

    #[test]
    fn build_args_net_allow_adds_fw_cfg() {
        let img = fake_image_dir();
        let ws = tempfile::tempdir().unwrap();
        let mut config = test_config(img.path(), ws.path());
        config.net_allow = vec!["example.com".into(), "10.0.0.0/8".into()];

        let args = build_args(&config, &Accelerator::Tcg).unwrap();
        let fw_cfg_idx = args.iter().position(|a| a == "-fw_cfg").expect("should have -fw_cfg");
        let fw_cfg_val = &args[fw_cfg_idx + 1];
        assert!(
            fw_cfg_val.contains("example.com,10.0.0.0/8"),
            "fw_cfg should contain allowlist: {fw_cfg_val}"
        );
        assert!(fw_cfg_val.contains("opt/omni/net_allowlist"));
    }

    #[test]
    fn build_args_port_forwarding() {
        let img = fake_image_dir();
        let ws = tempfile::tempdir().unwrap();
        let mut config = test_config(img.path(), ws.path());
        config.agent_port = 12345;
        config.code_server_port = 23456;
        config.vnc_port = 34567;

        let args = build_args(&config, &Accelerator::Tcg).unwrap();
        let netdev = args.iter().find(|a| a.starts_with("user,id=net0")).unwrap();
        assert!(netdev.contains("hostfwd=tcp::12345-:7681"), "agent port: {netdev}");
        assert!(netdev.contains("hostfwd=tcp::23456-:8080"), "code-server port: {netdev}");
        assert!(netdev.contains("hostfwd=tcp::34567-:6080"), "vnc port: {netdev}");
    }

    #[test]
    fn build_args_workspace_with_spaces() {
        let img = fake_image_dir();
        let ws_base = tempfile::tempdir().unwrap();
        let ws = ws_base.path().join("my project dir");
        fs::create_dir(&ws).unwrap();

        let config = test_config(img.path(), &ws);
        let args = build_args(&config, &Accelerator::Tcg).unwrap();
        let virtfs = args.iter().find(|a| a.contains("mount_tag=workspace")).unwrap();
        assert!(
            virtfs.contains("my project dir"),
            "workspace path with spaces should be in virtfs arg: {virtfs}"
        );
    }

    #[test]
    fn build_args_missing_kernel() {
        let dir = tempfile::tempdir().unwrap();
        // Only create initrd and rootfs — no kernel.
        fs::write(dir.path().join("initrd.img"), "x").unwrap();
        fs::write(dir.path().join("rootfs.ext4"), "x").unwrap();
        let ws = tempfile::tempdir().unwrap();

        let config = test_config(dir.path(), ws.path());
        let result = build_args(&config, &Accelerator::Tcg);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("kernel"));
    }

    #[test]
    fn build_args_missing_initrd() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("vmlinuz"), "x").unwrap();
        fs::write(dir.path().join("rootfs.ext4"), "x").unwrap();
        let ws = tempfile::tempdir().unwrap();

        let config = test_config(dir.path(), ws.path());
        let result = build_args(&config, &Accelerator::Tcg);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("initrd"));
    }

    #[test]
    fn build_args_missing_rootfs() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("vmlinuz"), "x").unwrap();
        fs::write(dir.path().join("initrd.img"), "x").unwrap();
        let ws = tempfile::tempdir().unwrap();

        let config = test_config(dir.path(), ws.path());
        let result = build_args(&config, &Accelerator::Tcg);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("rootfs"));
    }

    #[test]
    fn qemu_binary_name_format() {
        let name = qemu_binary_name();
        assert!(name.starts_with("qemu-system-"), "should start with qemu-system-: {name}");
        if cfg!(target_arch = "x86_64") {
            assert!(name.contains("x86_64"));
        } else if cfg!(target_arch = "aarch64") {
            assert!(name.contains("aarch64"));
        }
        if cfg!(windows) {
            assert!(name.ends_with(".exe"));
        } else {
            assert!(!name.ends_with(".exe"));
        }
    }
}
