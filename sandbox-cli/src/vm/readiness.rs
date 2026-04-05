use anyhow::{bail, Result};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Wait for the agent server to accept TCP connections on the given port.
///
/// The VM boots, runs its init script (mount workspace, start PostgreSQL,
/// start Redis, start omni agent), then the agent begins listening on port
/// 7681 (forwarded to `host_port` via QEMU user-mode networking).
///
/// This function polls the port until a connection succeeds or the timeout
/// is reached.
pub fn wait_for_agent(host_port: u16, timeout: Duration) -> Result<()> {
    let start = Instant::now();
    let addr = format!("127.0.0.1:{host_port}");
    let poll_interval = Duration::from_millis(500);

    eprintln!("omni-sandbox: waiting for agent on port {host_port}...");

    loop {
        if start.elapsed() >= timeout {
            bail!(
                "VM agent did not become ready within {} seconds on port {host_port}",
                timeout.as_secs()
            );
        }

        match TcpStream::connect_timeout(
            &addr.parse().unwrap(),
            Duration::from_millis(500),
        ) {
            Ok(_) => {
                eprintln!(
                    "omni-sandbox: agent ready on port {host_port} (took {:.1}s)",
                    start.elapsed().as_secs_f64()
                );
                return Ok(());
            }
            Err(_) => {
                std::thread::sleep(poll_interval);
            }
        }
    }
}
