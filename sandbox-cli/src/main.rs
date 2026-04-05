mod sandbox;
mod vm;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::ExitCode;

/// Cross-platform sandbox for Omni Code.
///
/// Two modes of operation:
///
///   exec (default): Process-level sandbox using platform-native isolation
///     - Linux:   bubblewrap (user namespaces + seccomp)
///     - macOS:   sandbox-exec (seatbelt profiles)
///     - Windows: AppContainer (restricted tokens + ACLs)
///
///   vm: QEMU-based VM sandbox with a pre-built rootfs image
///     - Full Ubuntu environment with all tools pre-installed
///     - No Docker, no admin privileges, no container runtime required
///     - Cross-platform: KVM (Linux), HVF (macOS), WHPX/TCG (Windows)
#[derive(Parser, Debug)]
#[command(name = "omni-sandbox", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    // --- Flat args for backward-compatible `exec` mode ---
    // When no subcommand is given, these are used directly.

    /// Directory to mount read-write inside the sandbox (the workspace).
    #[arg(long, global = false)]
    workspace: Option<PathBuf>,

    /// Additional directories to mount read-only.
    #[arg(long = "ro-bind")]
    ro_bind: Vec<PathBuf>,

    /// Additional directories to mount read-write.
    #[arg(long = "rw-bind")]
    rw_bind: Vec<PathBuf>,

    /// Allow network access (default: blocked).
    #[arg(long, default_value_t = false)]
    net: bool,

    /// Allow network access only to these hosts (comma-separated).
    #[arg(long, value_delimiter = ',')]
    net_allow: Vec<String>,

    /// Working directory inside the sandbox (defaults to workspace mount point).
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// Subpath names within writable roots to protect as read-only.
    #[arg(long = "protect")]
    protected_subpaths: Vec<String>,

    /// Disable default protected subpath enforcement.
    #[arg(long = "no-protected-subpaths", default_value_t = false)]
    no_protected_subpaths: bool,

    /// The command to run inside the sandbox (exec mode only).
    #[arg(last = true)]
    exec_command: Vec<String>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Run a process inside a platform-native sandbox.
    Exec(ExecArgs),
    /// Manage and run QEMU VM sandboxes.
    Vm(vm::VmArgs),
}

#[derive(Parser, Debug)]
struct ExecArgs {
    /// Directory to mount read-write inside the sandbox (the workspace).
    #[arg(long)]
    workspace: PathBuf,

    /// Additional directories to mount read-only.
    #[arg(long = "ro-bind")]
    ro_bind: Vec<PathBuf>,

    /// Additional directories to mount read-write.
    #[arg(long = "rw-bind")]
    rw_bind: Vec<PathBuf>,

    /// Allow network access (default: blocked).
    #[arg(long, default_value_t = false)]
    net: bool,

    /// Allow network access only to these hosts (comma-separated).
    #[arg(long, value_delimiter = ',')]
    net_allow: Vec<String>,

    /// Working directory inside the sandbox (defaults to workspace mount point).
    #[arg(long)]
    cwd: Option<PathBuf>,

    /// Subpath names within writable roots to protect as read-only.
    #[arg(long = "protect")]
    protected_subpaths: Vec<String>,

    /// Disable default protected subpath enforcement.
    #[arg(long = "no-protected-subpaths", default_value_t = false)]
    no_protected_subpaths: bool,

    /// The command to run inside the sandbox.
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let result = match cli.command {
        Some(Command::Exec(args)) => run_exec(args),
        Some(Command::Vm(args)) => vm::run(args),
        None => {
            // Backward-compatible: no subcommand means exec mode with flat args.
            let workspace = match cli.workspace {
                Some(ws) => ws,
                None => {
                    eprintln!("omni-sandbox: --workspace is required (or use a subcommand: exec, vm)");
                    return ExitCode::from(2);
                }
            };
            if cli.exec_command.is_empty() {
                eprintln!("omni-sandbox: no command specified");
                return ExitCode::from(2);
            }
            run_exec(ExecArgs {
                workspace,
                ro_bind: cli.ro_bind,
                rw_bind: cli.rw_bind,
                net: cli.net,
                net_allow: cli.net_allow,
                cwd: cli.cwd,
                protected_subpaths: cli.protected_subpaths,
                no_protected_subpaths: cli.no_protected_subpaths,
                command: cli.exec_command,
            })
        }
    };

    match result {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("omni-sandbox: {e:#}");
            ExitCode::from(125)
        }
    }
}

fn run_exec(args: ExecArgs) -> Result<u8> {
    let workspace = args
        .workspace
        .canonicalize()
        .with_context(|| format!("workspace path not found: {}", args.workspace.display()))?;

    let allow_net = args.net || !args.net_allow.is_empty();

    let protected_subpaths = if args.no_protected_subpaths {
        Vec::new()
    } else if args.protected_subpaths.is_empty() {
        sandbox::DEFAULT_PROTECTED_SUBPATHS
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        args.protected_subpaths
    };

    let config = sandbox::SandboxConfig {
        workspace,
        ro_binds: args.ro_bind,
        rw_binds: args.rw_bind,
        allow_net,
        net_allow_hosts: args.net_allow,
        cwd: args.cwd,
        command: args.command,
        protected_subpaths,
    };

    sandbox::exec(config)
}
