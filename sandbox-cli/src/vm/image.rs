use anyhow::{bail, Context, Result};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Image manifest stored alongside the cached rootfs.
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct Manifest {
    pub version: String,
    pub arch: String,
    pub rootfs_sha256: String,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub downloaded_at: String,
    pub rootfs_size_bytes: u64,
}

/// Default download base URL. Override with `--url` on `vm image pull`.
const DEFAULT_BASE_URL: &str = "https://github.com/ericmichael/omni-desktop/releases/download/vm-images";

/// Return the default cache directory for VM images.
pub fn default_cache_dir() -> Result<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        dirs::home_dir()
            .map(|h| h.join("Library/Application Support/OmniCode/vm"))
    } else if cfg!(target_os = "windows") {
        dirs::data_local_dir().map(|d| d.join("OmniCode/vm"))
    } else {
        // Linux / other: XDG_DATA_HOME or ~/.local/share
        dirs::data_dir().map(|d| d.join("omni-code/vm"))
    };

    base.context("could not determine data directory for VM image cache")
}

/// Ensure the rootfs image is downloaded and ready.
pub fn ensure_ready(cache_dir: &Path) -> Result<()> {
    let manifest_path = cache_dir.join("manifest.json");
    let kernel_path = cache_dir.join("vmlinuz");
    let initrd_path = cache_dir.join("initrd.img");
    let rootfs_path = cache_dir.join("rootfs.ext4");

    if manifest_path.exists() && kernel_path.exists() && initrd_path.exists() && rootfs_path.exists()
    {
        // Verify manifest is parseable.
        let data = fs::read_to_string(&manifest_path)
            .context("reading manifest.json")?;
        let _manifest: Manifest =
            serde_json::from_str(&data).context("parsing manifest.json")?;
        eprintln!("omni-sandbox: using cached VM image at {}", cache_dir.display());
        return Ok(());
    }

    eprintln!("omni-sandbox: VM image not found, downloading...");
    let arch = host_arch();
    pull(cache_dir, None, arch)?;
    Ok(())
}

/// Download the VM image to the cache directory.
pub fn pull(cache_dir: &Path, url_override: Option<&str>, arch: &str) -> Result<()> {
    fs::create_dir_all(cache_dir)
        .with_context(|| format!("creating cache dir: {}", cache_dir.display()))?;

    let base_url = url_override.unwrap_or(DEFAULT_BASE_URL);

    // Download each artifact.
    let artifacts = [
        ("vmlinuz", "vmlinuz"),
        ("initrd.img", "initrd.img"),
        ("rootfs.ext4.zst", "rootfs.ext4.zst"),
    ];

    for (remote_name, local_name) in &artifacts {
        let url = format!("{base_url}/{arch}/{remote_name}");
        let dest = cache_dir.join(local_name);
        download_file(&url, &dest)?;
    }

    // Decompress rootfs.
    let compressed = cache_dir.join("rootfs.ext4.zst");
    let decompressed = cache_dir.join("rootfs.ext4");

    if compressed.exists() {
        eprintln!("omni-sandbox: decompressing rootfs...");
        decompress_zstd(&compressed, &decompressed)?;
        fs::remove_file(&compressed).ok();
    }

    // Compute SHA256 hashes.
    let rootfs_hash = sha256_file(&decompressed)?;
    let kernel_hash = sha256_file(&cache_dir.join("vmlinuz"))?;
    let initrd_hash = sha256_file(&cache_dir.join("initrd.img"))?;
    let rootfs_size = fs::metadata(&decompressed)
        .map(|m| m.len())
        .unwrap_or(0);

    // Write manifest.
    let manifest = Manifest {
        version: "1.0.0".to_string(),
        arch: arch.to_string(),
        rootfs_sha256: rootfs_hash,
        kernel_sha256: kernel_hash,
        initrd_sha256: initrd_hash,
        downloaded_at: chrono_now(),
        rootfs_size_bytes: rootfs_size,
    };

    let manifest_json = serde_json::to_string_pretty(&manifest)
        .context("serializing manifest")?;
    fs::write(cache_dir.join("manifest.json"), manifest_json)
        .context("writing manifest.json")?;

    eprintln!("omni-sandbox: image download complete ({} bytes)", rootfs_size);
    Ok(())
}

/// Show info about the cached image.
pub fn info(cache_dir: &Path) -> Result<()> {
    let manifest_path = cache_dir.join("manifest.json");
    if !manifest_path.exists() {
        eprintln!("No VM image cached. Run `omni-sandbox vm image pull` to download.");
        return Ok(());
    }

    let data = fs::read_to_string(&manifest_path)?;
    let manifest: Manifest = serde_json::from_str(&data)?;

    eprintln!("VM Image Info:");
    eprintln!("  Version:      {}", manifest.version);
    eprintln!("  Architecture: {}", manifest.arch);
    eprintln!("  Rootfs size:  {} MB", manifest.rootfs_size_bytes / 1_048_576);
    eprintln!("  Downloaded:   {}", manifest.downloaded_at);
    eprintln!("  Cache dir:    {}", cache_dir.display());
    eprintln!("  Rootfs SHA256: {}", manifest.rootfs_sha256);

    Ok(())
}

/// Remove the cached image.
pub fn prune(cache_dir: &Path) -> Result<()> {
    if cache_dir.exists() {
        fs::remove_dir_all(cache_dir)
            .with_context(|| format!("removing cache dir: {}", cache_dir.display()))?;
    }
    Ok(())
}

/// Detect host CPU architecture as a string for image selection.
pub fn host_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}

/// Download a file from `url` to `dest`, showing progress on stderr.
fn download_file(url: &str, dest: &Path) -> Result<()> {
    eprintln!("omni-sandbox: downloading {url}");

    let resp = ureq::get(url)
        .call()
        .with_context(|| format!("HTTP request failed: {url}"))?;

    let status = resp.status().as_u16();
    if status != 200 {
        bail!("HTTP {status} for {url}");
    }

    let total_size: Option<u64> = resp
        .headers()
        .get("Content-Length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());

    let mut reader = resp.into_body().into_reader();
    let mut file = fs::File::create(dest)
        .with_context(|| format!("creating file: {}", dest.display()))?;

    let mut downloaded: u64 = 0;
    let mut buf = vec![0u8; 256 * 1024]; // 256KB buffer
    let mut last_report = std::time::Instant::now();

    loop {
        let n = reader.read(&mut buf).context("reading HTTP response")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        downloaded += n as u64;

        // Progress report every 2 seconds.
        if last_report.elapsed() >= std::time::Duration::from_secs(2) {
            if let Some(total) = total_size {
                let pct = (downloaded as f64 / total as f64 * 100.0) as u32;
                eprint!(
                    "\romni-sandbox: {} / {} MB ({}%)",
                    downloaded / 1_048_576,
                    total / 1_048_576,
                    pct
                );
            } else {
                eprint!("\romni-sandbox: {} MB downloaded", downloaded / 1_048_576);
            }
            last_report = std::time::Instant::now();
        }
    }
    eprintln!(); // newline after progress

    Ok(())
}

/// Decompress a zstd-compressed file.
fn decompress_zstd(src: &Path, dest: &Path) -> Result<()> {
    let input = fs::File::open(src)
        .with_context(|| format!("opening compressed file: {}", src.display()))?;
    let mut decoder = zstd::Decoder::new(input)
        .context("creating zstd decoder")?;
    let mut output = fs::File::create(dest)
        .with_context(|| format!("creating output file: {}", dest.display()))?;
    std::io::copy(&mut decoder, &mut output)
        .context("decompressing rootfs")?;
    Ok(())
}

/// Compute SHA256 hash of a file, returning the hex string.
fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};

    let mut file = fs::File::open(path)
        .with_context(|| format!("opening file for hashing: {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Current time as ISO 8601 string (without pulling in chrono).
fn chrono_now() -> String {
    // Use SystemTime for a basic timestamp.
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}", duration.as_secs())
}
