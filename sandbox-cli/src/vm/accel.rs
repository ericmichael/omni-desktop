use std::fmt;

/// Hardware acceleration backend for QEMU.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // Variants are platform-specific; all are used across targets.
pub enum Accelerator {
    /// Linux KVM (near-native speed, requires /dev/kvm access).
    Kvm,
    /// macOS Hypervisor.framework (near-native speed, no admin needed).
    Hvf,
    /// Windows Hypervisor Platform (near-native speed, requires Hyper-V enabled).
    Whpx,
    /// Software emulation (works everywhere, ~3-5x slower).
    Tcg,
}

impl fmt::Display for Accelerator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Accelerator::Kvm => write!(f, "KVM"),
            Accelerator::Hvf => write!(f, "HVF (Hypervisor.framework)"),
            Accelerator::Whpx => write!(f, "WHPX (Windows Hypervisor Platform)"),
            Accelerator::Tcg => write!(f, "TCG (software emulation)"),
        }
    }
}

impl Accelerator {
    /// QEMU `-accel` flag value.
    pub fn qemu_flag(&self) -> &'static str {
        match self {
            Accelerator::Kvm => "kvm",
            Accelerator::Hvf => "hvf",
            Accelerator::Whpx => "whpx",
            Accelerator::Tcg => "tcg",
        }
    }

    /// QEMU `-cpu` flag value. Hardware accelerators use `host` to pass through
    /// the real CPU features. TCG uses `max` for best software emulation.
    pub fn cpu_flag(&self) -> &'static str {
        match self {
            Accelerator::Tcg => "max",
            _ => "host",
        }
    }
}

/// Detect the best available hardware acceleration for the current platform.
pub fn detect() -> Accelerator {
    #[cfg(target_os = "linux")]
    {
        if kvm_available() {
            return Accelerator::Kvm;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if hvf_available() {
            return Accelerator::Hvf;
        }
    }

    #[cfg(target_os = "windows")]
    {
        if whpx_available() {
            return Accelerator::Whpx;
        }
    }

    Accelerator::Tcg
}

/// Check if /dev/kvm is accessible (user is in `kvm` group or has ACL access).
#[cfg(target_os = "linux")]
fn kvm_available() -> bool {
    use std::fs;
    // Check both existence and read+write access.
    match fs::metadata("/dev/kvm") {
        Ok(_) => {
            // Try opening for read+write to confirm access permission.
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open("/dev/kvm")
                .is_ok()
        }
        Err(_) => false,
    }
}

/// Check if Hypervisor.framework is available (kern.hv_support sysctl).
#[cfg(target_os = "macos")]
fn hvf_available() -> bool {
    std::process::Command::new("sysctl")
        .args(["-n", "kern.hv_support"])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout).trim() == "1"
        })
        .unwrap_or(false)
}

/// Check if Windows Hypervisor Platform is available.
#[cfg(target_os = "windows")]
fn whpx_available() -> bool {
    // Check for the WHvGetCapability API by trying to load the DLL.
    // A simpler heuristic: check if the WinHvPlatform service exists.
    std::process::Command::new("sc")
        .args(["query", "WinHvr"])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kvm_qemu_flag() {
        assert_eq!(Accelerator::Kvm.qemu_flag(), "kvm");
    }

    #[test]
    fn hvf_qemu_flag() {
        assert_eq!(Accelerator::Hvf.qemu_flag(), "hvf");
    }

    #[test]
    fn whpx_qemu_flag() {
        assert_eq!(Accelerator::Whpx.qemu_flag(), "whpx");
    }

    #[test]
    fn tcg_qemu_flag() {
        assert_eq!(Accelerator::Tcg.qemu_flag(), "tcg");
    }

    #[test]
    fn tcg_cpu_flag_is_max() {
        assert_eq!(Accelerator::Tcg.cpu_flag(), "max");
    }

    #[test]
    fn hardware_accel_cpu_flag_is_host() {
        for accel in [Accelerator::Kvm, Accelerator::Hvf, Accelerator::Whpx] {
            assert_eq!(accel.cpu_flag(), "host", "{accel} should use host CPU");
        }
    }

    #[test]
    fn detect_returns_valid_accelerator() {
        // Should not panic on any platform.
        let accel = detect();
        // Verify it's a known variant by checking Display is non-empty.
        let display = format!("{accel}");
        assert!(!display.is_empty());
    }

    #[test]
    fn display_formatting() {
        assert!(format!("{}", Accelerator::Kvm).contains("KVM"));
        assert!(format!("{}", Accelerator::Hvf).contains("HVF"));
        assert!(format!("{}", Accelerator::Whpx).contains("WHPX"));
        assert!(format!("{}", Accelerator::Tcg).contains("TCG"));
    }
}
