use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// Default directory names that should be protected (read-only) even inside
/// writable roots. These are re-bound as read-only after the writable mount
/// so the sandboxed process cannot modify them.
pub const DEFAULT_PROTECTED_SUBPATHS: &[&str] = &[".git", ".env", ".codex"];

/// Platform-agnostic sandbox configuration.
pub struct SandboxConfig {
    /// Primary workspace directory — mounted read-write.
    pub workspace: PathBuf,
    /// Extra read-only bind mounts.
    pub ro_binds: Vec<PathBuf>,
    /// Extra read-write bind mounts.
    pub rw_binds: Vec<PathBuf>,
    /// Whether outbound network access is permitted.
    pub allow_net: bool,
    /// Optional host-level allowlist (best-effort — not all backends support it).
    pub net_allow_hosts: Vec<String>,
    /// Working directory inside the sandbox (defaults to workspace).
    pub cwd: Option<PathBuf>,
    /// The command + arguments to execute.
    pub command: Vec<String>,
    /// Subpath names within writable roots to protect as read-only.
    /// Defaults to [`.git`, `.env`, `.codex`] if empty.
    pub protected_subpaths: Vec<String>,
}

/// Launch the sandboxed process. Returns the child's exit code.
///
/// On Linux this calls `bwrap`, on macOS `sandbox-exec`, on Windows
/// the AppContainer API. Fails with an error if the sandbox cannot be
/// established — there is no unsandboxed fallback.
pub fn exec(config: SandboxConfig) -> anyhow::Result<u8> {
    #[cfg(target_os = "linux")]
    return linux::exec(config);

    #[cfg(target_os = "macos")]
    return macos::exec(config);

    #[cfg(target_os = "windows")]
    return windows::exec(config);

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        anyhow::bail!(
            "No sandbox backend available for this platform. \
             Supported platforms: Linux, macOS, Windows."
        )
    }
}
