mod accel;
mod image;
mod qemu;
mod readiness;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
pub struct VmArgs {
    #[command(subcommand)]
    pub command: VmCommand,
}

#[derive(Subcommand, Debug)]
pub enum VmCommand {
    /// Boot a VM sandbox with the workspace mounted.
    Run(VmRunArgs),
    /// Manage the rootfs image (download, update, info).
    Image(VmImageArgs),
}

#[derive(Parser, Debug)]
pub struct VmRunArgs {
    /// Directory to mount read-write inside the VM (the workspace).
    #[arg(long)]
    pub workspace: PathBuf,

    /// Memory in megabytes (default: 4096).
    #[arg(long, default_value_t = 4096)]
    pub memory: u32,

    /// Number of CPU cores (default: 2).
    #[arg(long, default_value_t = 2)]
    pub cpus: u32,

    /// Host port for the agent server (default: auto).
    #[arg(long, default_value_t = 0)]
    pub port: u16,

    /// Host port for code-server (default: auto).
    #[arg(long, default_value_t = 0)]
    pub code_server_port: u16,

    /// Host port for noVNC (default: auto).
    #[arg(long, default_value_t = 0)]
    pub vnc_port: u16,

    /// Path to a custom rootfs image directory (overrides default cache).
    #[arg(long)]
    pub image_dir: Option<PathBuf>,

    /// Network allowlist (comma-separated hostnames/IPs/CIDRs).
    /// If empty, the VM has full outbound internet access via QEMU user-mode networking.
    #[arg(long, value_delimiter = ',')]
    pub net_allow: Vec<String>,

    /// Block all outbound network access from the VM.
    #[arg(long, default_value_t = false)]
    pub no_net: bool,

    /// Output format: "json" emits a JSON payload on stdout when ready.
    #[arg(long, default_value = "json")]
    pub output: String,
}

#[derive(Parser, Debug)]
pub struct VmImageArgs {
    #[command(subcommand)]
    pub command: VmImageCommand,
}

#[derive(Subcommand, Debug)]
pub enum VmImageCommand {
    /// Download or update the rootfs image.
    Pull(VmImagePullArgs),
    /// Show info about the cached rootfs image.
    Info,
    /// Remove the cached rootfs image.
    Prune,
}

#[derive(Parser, Debug)]
pub struct VmImagePullArgs {
    /// Override the download URL for the rootfs image.
    #[arg(long)]
    pub url: Option<String>,

    /// Target architecture (default: auto-detect).
    #[arg(long)]
    pub arch: Option<String>,
}

/// VM sandbox configuration (resolved from CLI args).
pub struct VmConfig {
    pub workspace: PathBuf,
    pub memory_mb: u32,
    pub cpus: u32,
    pub agent_port: u16,
    pub code_server_port: u16,
    pub vnc_port: u16,
    pub image_dir: PathBuf,
    pub net_allow: Vec<String>,
    pub no_net: bool,
}

/// Entry point for all `vm` subcommands.
pub fn run(args: VmArgs) -> Result<u8> {
    match args.command {
        VmCommand::Run(run_args) => cmd_run(run_args),
        VmCommand::Image(img_args) => cmd_image(img_args),
    }
}

fn cmd_run(args: VmRunArgs) -> Result<u8> {
    let workspace = args
        .workspace
        .canonicalize()
        .with_context(|| format!("workspace path not found: {}", args.workspace.display()))?;

    let image_dir = match args.image_dir {
        Some(dir) => dir,
        None => image::default_cache_dir()?,
    };

    // Ensure rootfs is downloaded.
    image::ensure_ready(&image_dir)?;

    // Detect hardware acceleration.
    let accelerator = accel::detect();
    eprintln!("omni-sandbox: using acceleration: {accelerator}");

    // Find QEMU binary.
    let qemu_bin = qemu::find_binary()?;
    eprintln!("omni-sandbox: using QEMU: {}", qemu_bin.display());

    // Allocate host ports.
    let agent_port = pick_port(args.port)?;
    let code_server_port = pick_port(args.code_server_port)?;
    let vnc_port = pick_port(args.vnc_port)?;

    let config = VmConfig {
        workspace,
        memory_mb: args.memory,
        cpus: args.cpus,
        agent_port,
        code_server_port,
        vnc_port,
        image_dir,
        net_allow: args.net_allow,
        no_net: args.no_net,
    };

    // Build and spawn QEMU.
    let mut child = qemu::spawn(&qemu_bin, &config, &accelerator)?;

    // Wait for the agent to be ready inside the VM.
    let timeout = std::time::Duration::from_secs(120);
    readiness::wait_for_agent(agent_port, timeout)?;

    // Emit JSON payload (compatible with Docker sandbox output format).
    if args.output == "json" {
        let payload = serde_json::json!({
            "sandbox_url": format!("http://127.0.0.1:{}/api", agent_port),
            "ws_url": format!("ws://127.0.0.1:{}/ws", agent_port),
            "ui_url": format!("http://127.0.0.1:{}", agent_port),
            "code_server_url": format!("http://127.0.0.1:{}", code_server_port),
            "novnc_url": format!("http://127.0.0.1:{}", vnc_port),
            "container_id": serde_json::Value::Null,
            "container_name": serde_json::Value::Null,
            "ports": {
                "sandbox": agent_port,
                "ui": agent_port,
                "code_server": code_server_port,
                "vnc": vnc_port,
            }
        });
        println!("{}", serde_json::to_string(&payload)?);
    }

    // Wait for QEMU to exit (blocks until VM shuts down or is killed).
    let status = child.wait().context("waiting for QEMU process")?;
    Ok(status.code().unwrap_or(1) as u8)
}

fn cmd_image(args: VmImageArgs) -> Result<u8> {
    match args.command {
        VmImageCommand::Pull(pull_args) => {
            let cache_dir = image::default_cache_dir()?;
            let arch = pull_args.arch.unwrap_or_else(|| image::host_arch().to_string());
            image::pull(&cache_dir, pull_args.url.as_deref(), &arch)?;
            eprintln!("omni-sandbox: image ready at {}", cache_dir.display());
            Ok(0)
        }
        VmImageCommand::Info => {
            let cache_dir = image::default_cache_dir()?;
            image::info(&cache_dir)?;
            Ok(0)
        }
        VmImageCommand::Prune => {
            let cache_dir = image::default_cache_dir()?;
            image::prune(&cache_dir)?;
            eprintln!("omni-sandbox: image cache pruned");
            Ok(0)
        }
    }
}

/// Pick an available port. If `requested` is 0, bind to port 0 and let the OS choose.
pub(crate) fn pick_port(requested: u16) -> Result<u16> {
    if requested != 0 {
        return Ok(requested);
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .context("failed to bind to an ephemeral port")?;
    let port = listener
        .local_addr()
        .context("failed to get local address")?
        .port();
    // Drop the listener so the port is free for QEMU to use.
    drop(listener);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn pick_port_zero_returns_ephemeral() {
        let port = pick_port(0).unwrap();
        assert!(port > 0, "ephemeral port should be > 0, got {port}");
    }

    #[test]
    fn pick_port_specific_returns_same() {
        assert_eq!(pick_port(8080).unwrap(), 8080);
        assert_eq!(pick_port(3000).unwrap(), 3000);
    }

    #[test]
    fn pick_port_two_calls_return_different() {
        let a = pick_port(0).unwrap();
        let b = pick_port(0).unwrap();
        // The OS should assign different ports (not guaranteed but extremely likely).
        assert_ne!(a, b, "two ephemeral ports should differ");
    }

    // CLI parsing tests use the top-level Cli struct from main.

    #[test]
    fn vm_run_args_parse() {
        let args = VmRunArgs::try_parse_from([
            "run",
            "--workspace", "/tmp/project",
            "--memory", "8192",
            "--cpus", "4",
            "--port", "7681",
        ]).unwrap();

        assert_eq!(args.workspace, std::path::PathBuf::from("/tmp/project"));
        assert_eq!(args.memory, 8192);
        assert_eq!(args.cpus, 4);
        assert_eq!(args.port, 7681);
        assert!(!args.no_net);
        assert!(args.net_allow.is_empty());
    }

    #[test]
    fn vm_run_args_defaults() {
        let args = VmRunArgs::try_parse_from([
            "run",
            "--workspace", "/tmp",
        ]).unwrap();

        assert_eq!(args.memory, 4096);
        assert_eq!(args.cpus, 2);
        assert_eq!(args.port, 0);
        assert_eq!(args.code_server_port, 0);
        assert_eq!(args.vnc_port, 0);
    }

    #[test]
    fn vm_run_args_no_net() {
        let args = VmRunArgs::try_parse_from([
            "run",
            "--workspace", "/tmp",
            "--no-net",
        ]).unwrap();
        assert!(args.no_net);
    }

    #[test]
    fn vm_run_args_net_allow() {
        let args = VmRunArgs::try_parse_from([
            "run",
            "--workspace", "/tmp",
            "--net-allow", "example.com,10.0.0.0/8",
        ]).unwrap();
        assert_eq!(args.net_allow, vec!["example.com", "10.0.0.0/8"]);
    }

    #[test]
    fn vm_image_pull_args_parse() {
        let args = VmImagePullArgs::try_parse_from([
            "pull",
            "--arch", "aarch64",
            "--url", "https://example.com/images",
        ]).unwrap();
        assert_eq!(args.arch.as_deref(), Some("aarch64"));
        assert_eq!(args.url.as_deref(), Some("https://example.com/images"));
    }

    #[test]
    fn vm_image_pull_args_defaults() {
        let args = VmImagePullArgs::try_parse_from(["pull"]).unwrap();
        assert!(args.arch.is_none());
        assert!(args.url.is_none());
    }
}
