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
pub(crate) fn decompress_zstd(src: &Path, dest: &Path) -> Result<()> {
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
pub(crate) fn sha256_file(path: &Path) -> Result<String> {
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
pub(crate) fn chrono_now() -> String {
    // Use SystemTime for a basic timestamp.
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}", duration.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_cache_dir_is_valid() {
        let dir = default_cache_dir().unwrap();
        assert!(!dir.as_os_str().is_empty());
        // On Linux, should be under XDG data dir.
        if cfg!(target_os = "linux") {
            let s = dir.to_string_lossy();
            assert!(
                s.contains("omni-code/vm"),
                "Linux cache dir should contain omni-code/vm: {s}"
            );
        }
    }

    #[test]
    fn host_arch_returns_known_value() {
        let arch = host_arch();
        assert!(
            arch == "x86_64" || arch == "aarch64",
            "unexpected arch: {arch}"
        );
    }

    #[test]
    fn sha256_known_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        fs::write(&path, "hello world\n").unwrap();

        let hash = sha256_file(&path).unwrap();
        // sha256("hello world\n") — verified with `echo "hello world" | sha256sum`.
        assert_eq!(
            hash,
            "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447"
        );
    }

    #[test]
    fn sha256_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty");
        fs::write(&path, "").unwrap();

        let hash = sha256_file(&path).unwrap();
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "should match well-known empty SHA256"
        );
    }

    #[test]
    fn sha256_missing_file() {
        let result = sha256_file(Path::new("/tmp/nonexistent_omni_test_file"));
        assert!(result.is_err());
    }

    #[test]
    fn decompress_zstd_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let original_data = b"The quick brown fox jumps over the lazy dog. Repeated for compression. ".repeat(100);

        // Compress with zstd.
        let compressed_path = dir.path().join("data.zst");
        let decompressed_path = dir.path().join("data.out");
        {
            let file = fs::File::create(&compressed_path).unwrap();
            let mut encoder = zstd::Encoder::new(file, 3).unwrap();
            std::io::Write::write_all(&mut encoder, &original_data).unwrap();
            encoder.finish().unwrap();
        }

        // Decompress with our function.
        decompress_zstd(&compressed_path, &decompressed_path).unwrap();

        let result = fs::read(&decompressed_path).unwrap();
        assert_eq!(result, original_data);
    }

    #[test]
    fn decompress_zstd_invalid_data() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("garbage.zst");
        let dest = dir.path().join("out");
        fs::write(&src, b"this is not zstd data at all").unwrap();

        let result = decompress_zstd(&src, &dest);
        assert!(result.is_err(), "should fail on invalid zstd data");
    }

    #[test]
    fn decompress_zstd_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let result = decompress_zstd(
            &dir.path().join("nonexistent.zst"),
            &dir.path().join("out"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn manifest_roundtrip() {
        let manifest = Manifest {
            version: "1.0.0".to_string(),
            arch: "x86_64".to_string(),
            rootfs_sha256: "abc123".to_string(),
            kernel_sha256: "def456".to_string(),
            initrd_sha256: "ghi789".to_string(),
            downloaded_at: "unix:1234567890".to_string(),
            rootfs_size_bytes: 1_073_741_824,
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let parsed: Manifest = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.version, "1.0.0");
        assert_eq!(parsed.arch, "x86_64");
        assert_eq!(parsed.rootfs_sha256, "abc123");
        assert_eq!(parsed.rootfs_size_bytes, 1_073_741_824);
    }

    #[test]
    fn ensure_ready_valid_cache() {
        let dir = tempfile::tempdir().unwrap();
        // Create all required files.
        fs::write(dir.path().join("vmlinuz"), "fake-kernel").unwrap();
        fs::write(dir.path().join("initrd.img"), "fake-initrd").unwrap();
        fs::write(dir.path().join("rootfs.ext4"), "fake-rootfs").unwrap();

        let manifest = Manifest {
            version: "1.0.0".to_string(),
            arch: "x86_64".to_string(),
            rootfs_sha256: "aaa".to_string(),
            kernel_sha256: "bbb".to_string(),
            initrd_sha256: "ccc".to_string(),
            downloaded_at: chrono_now(),
            rootfs_size_bytes: 100,
        };
        let json = serde_json::to_string(&manifest).unwrap();
        fs::write(dir.path().join("manifest.json"), json).unwrap();

        let result = ensure_ready(dir.path());
        assert!(result.is_ok(), "should succeed with valid cache: {result:?}");
    }

    #[test]
    fn ensure_ready_corrupt_manifest() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("vmlinuz"), "fake").unwrap();
        fs::write(dir.path().join("initrd.img"), "fake").unwrap();
        fs::write(dir.path().join("rootfs.ext4"), "fake").unwrap();
        fs::write(dir.path().join("manifest.json"), "not valid json {{{").unwrap();

        let result = ensure_ready(dir.path());
        assert!(result.is_err(), "should fail on corrupt manifest");
    }

    #[test]
    fn ensure_ready_missing_kernel_triggers_download() {
        let dir = tempfile::tempdir().unwrap();
        // Only create some files — missing vmlinuz.
        fs::write(dir.path().join("initrd.img"), "fake").unwrap();
        fs::write(dir.path().join("rootfs.ext4"), "fake").unwrap();
        fs::write(dir.path().join("manifest.json"), "{}").unwrap();

        // ensure_ready will try to download, which will fail (no network mock).
        // That's fine — we just verify it doesn't return Ok with missing files.
        let result = ensure_ready(dir.path());
        assert!(result.is_err(), "should not succeed with missing kernel");
    }

    #[test]
    fn prune_removes_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        fs::create_dir(&cache).unwrap();
        fs::write(cache.join("test"), "data").unwrap();

        prune(&cache).unwrap();
        assert!(!cache.exists(), "prune should remove the directory");
    }

    #[test]
    fn prune_nonexistent_dir_is_ok() {
        let result = prune(Path::new("/tmp/omni_test_nonexistent_cache_dir"));
        assert!(result.is_ok(), "prune on missing dir should be a no-op");
    }

    #[test]
    fn info_no_cache() {
        let dir = tempfile::tempdir().unwrap();
        // No manifest — should print a message but not error.
        let result = info(dir.path());
        assert!(result.is_ok());
    }

    #[test]
    fn chrono_now_format() {
        let ts = chrono_now();
        assert!(ts.starts_with("unix:"), "should be unix timestamp: {ts}");
        let secs: u64 = ts.strip_prefix("unix:").unwrap().parse().unwrap();
        assert!(secs > 1_700_000_000, "timestamp should be recent: {secs}");
    }
}
