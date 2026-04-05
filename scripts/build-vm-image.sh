#!/usr/bin/env bash
# build-vm-image.sh
#
# Converts the Dockerfile.work sandbox image into a QEMU-bootable VM image:
#   - vmlinuz        (Linux kernel extracted from the container)
#   - initrd.img     (initramfs)
#   - rootfs.ext4    (ext4 filesystem image)
#   - rootfs.ext4.zst (compressed for distribution)
#   - manifest.json  (SHA256 hashes + metadata)
#
# Prerequisites: docker, qemu-img (optional), zstd
#
# Usage:
#   ./scripts/build-vm-image.sh [--omni-code-version X.Y.Z] [--output-dir ./out/vm]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DOCKER_DIR="${PROJECT_DIR}/docker/sandbox"

# Defaults
OMNI_CODE_VERSION="${OMNI_CODE_VERSION:-}"
OUTPUT_DIR="${OUTPUT_DIR:-${PROJECT_DIR}/out/vm}"
ROOTFS_SIZE_GB="${ROOTFS_SIZE_GB:-12}"
IMAGE_TAG="omni-sandbox-vm-build"
ARCH="$(uname -m)"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --omni-code-version) OMNI_CODE_VERSION="$2"; shift 2 ;;
        --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
        --rootfs-size) ROOTFS_SIZE_GB="$2"; shift 2 ;;
        *) echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "${OMNI_CODE_VERSION}" ]]; then
    echo "Error: --omni-code-version is required (or set OMNI_CODE_VERSION env var)" >&2
    exit 1
fi

echo "==> Building VM image"
echo "    Omni Code version: ${OMNI_CODE_VERSION}"
echo "    Architecture:      ${ARCH}"
echo "    Rootfs size:       ${ROOTFS_SIZE_GB}GB"
echo "    Output directory:  ${OUTPUT_DIR}"
echo ""

mkdir -p "${OUTPUT_DIR}"

# ---------------------------------------------------------------------------
# Step 1: Build the Docker image (reuses existing Dockerfile.work)
# ---------------------------------------------------------------------------
echo "==> Step 1: Building Docker image..."

docker build \
    -f "${DOCKER_DIR}/Dockerfile.work" \
    --build-arg "OMNI_CODE_VERSION=${OMNI_CODE_VERSION}" \
    -t "${IMAGE_TAG}" \
    "${DOCKER_DIR}"

# ---------------------------------------------------------------------------
# Step 2: Create a container and extract kernel + initrd
# ---------------------------------------------------------------------------
echo "==> Step 2: Extracting kernel and initrd..."

CONTAINER_ID=$(docker create "${IMAGE_TAG}")
trap "docker rm -f ${CONTAINER_ID} >/dev/null 2>&1 || true" EXIT

# Extract kernel — try common paths
for kernel_path in \
    /boot/vmlinuz \
    "/boot/vmlinuz-*" \
    /vmlinuz; do
    docker cp "${CONTAINER_ID}:${kernel_path}" "${OUTPUT_DIR}/vmlinuz" 2>/dev/null && break || true
done

if [[ ! -f "${OUTPUT_DIR}/vmlinuz" ]]; then
    # Kernel not in the container image — download a matching one.
    echo "    Kernel not found in container, downloading..."
    KERNEL_VERSION="6.8.0-49-generic"
    if [[ "${ARCH}" == "aarch64" ]]; then
        PKG="linux-image-${KERNEL_VERSION}"
    else
        PKG="linux-image-${KERNEL_VERSION}"
    fi
    docker run --rm "${IMAGE_TAG}" bash -c \
        "apt-get update -qq && apt-get download -qq ${PKG} 2>/dev/null && dpkg-deb -x *.deb /tmp/kernel && cat /tmp/kernel/boot/vmlinuz-*" \
        > "${OUTPUT_DIR}/vmlinuz"
fi

# Extract initrd
for initrd_path in \
    /boot/initrd.img \
    "/boot/initrd.img-*" \
    /initrd.img; do
    docker cp "${CONTAINER_ID}:${initrd_path}" "${OUTPUT_DIR}/initrd.img" 2>/dev/null && break || true
done

if [[ ! -f "${OUTPUT_DIR}/initrd.img" ]]; then
    echo "    Initrd not found in container, generating minimal initramfs..."
    # Generate a minimal initramfs that can mount the root filesystem.
    docker run --rm --privileged "${IMAGE_TAG}" bash -c '
        apt-get update -qq >/dev/null 2>&1
        apt-get install -y -qq linux-image-generic initramfs-tools >/dev/null 2>&1
        KVER=$(ls /lib/modules/ | head -1)
        mkinitramfs -o /tmp/initrd.img "${KVER}"
        cat /tmp/initrd.img
    ' > "${OUTPUT_DIR}/initrd.img"
fi

echo "    vmlinuz:    $(du -h "${OUTPUT_DIR}/vmlinuz" | cut -f1)"
echo "    initrd.img: $(du -h "${OUTPUT_DIR}/initrd.img" | cut -f1)"

# ---------------------------------------------------------------------------
# Step 3: Export container filesystem to ext4 image
# ---------------------------------------------------------------------------
echo "==> Step 3: Creating rootfs.ext4 (${ROOTFS_SIZE_GB}GB)..."

ROOTFS="${OUTPUT_DIR}/rootfs.ext4"
ROOTFS_MOUNT="${OUTPUT_DIR}/.rootfs-mount"

# Create a sparse ext4 image.
dd if=/dev/zero of="${ROOTFS}" bs=1 count=0 seek="${ROOTFS_SIZE_GB}G" 2>/dev/null
mkfs.ext4 -q -F -L omni-rootfs "${ROOTFS}"

# Mount and extract the container filesystem into it.
mkdir -p "${ROOTFS_MOUNT}"

# Use a loop device (requires running this script with appropriate permissions,
# OR use fakeroot/unshare to avoid needing root).
if command -v udisksctl >/dev/null 2>&1; then
    # Try udisksctl (works without root on many desktop Linux systems).
    LOOP_DEV=$(udisksctl loop-setup -f "${ROOTFS}" --no-user-interaction 2>/dev/null | grep -oP '/dev/loop\d+' || true)
    if [[ -n "${LOOP_DEV}" ]]; then
        udisksctl mount -b "${LOOP_DEV}" --no-user-interaction 2>/dev/null || true
        ROOTFS_MOUNT=$(findmnt -n -o TARGET "${LOOP_DEV}" 2>/dev/null || echo "${ROOTFS_MOUNT}")
        USE_UDISKS=1
    fi
fi

if [[ -z "${USE_UDISKS:-}" ]]; then
    # Fallback: use docker to do the mount+extract (works without root on host).
    echo "    Using Docker to populate rootfs (no root needed on host)..."
    docker export "${CONTAINER_ID}" | docker run --rm -i \
        -v "${ROOTFS}:/rootfs.ext4" \
        --privileged \
        ubuntu:24.04 bash -c '
            apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq e2fsprogs >/dev/null 2>&1
            mkdir -p /mnt/rootfs
            mount -o loop /rootfs.ext4 /mnt/rootfs
            tar xf - -C /mnt/rootfs
            # Copy VM init script
            cat > /mnt/rootfs/etc/rc.local << "INITEOF"
#!/bin/bash
exec /usr/local/bin/omni-vm-init
INITEOF
            chmod +x /mnt/rootfs/etc/rc.local
            umount /mnt/rootfs
        '
fi

# ---------------------------------------------------------------------------
# Step 4: Inject the VM init script into the rootfs
# ---------------------------------------------------------------------------
echo "==> Step 4: Injecting VM init script..."

# We write the init script via Docker since we may not have the rootfs mounted.
docker run --rm \
    -v "${ROOTFS}:/rootfs.ext4" \
    --privileged \
    ubuntu:24.04 bash -c '
        apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq e2fsprogs >/dev/null 2>&1
        mkdir -p /mnt/rootfs
        mount -o loop /rootfs.ext4 /mnt/rootfs

        # Write the VM init script
        cat > /mnt/rootfs/usr/local/bin/omni-vm-init << "VMEOF"
#!/bin/bash
set -euo pipefail

# Mount workspace from 9p virtio share.
mkdir -p /home/user/workspace
mount -t 9p -o trans=virtio,version=9p2000.L,msize=104857600 workspace /home/user/workspace 2>/dev/null || \
    echo "WARNING: workspace mount failed (9p)" >&2

# Fix ownership — use UID 1000 (the default "user" account).
chown -R 1000:1000 /home/user 2>/dev/null || true

# Read network allowlist from QEMU fw_cfg if available.
ALLOWLIST=""
if [[ -f /sys/firmware/qemu_fw_cfg/by_name/opt/omni/net_allowlist/raw ]]; then
    ALLOWLIST=$(cat /sys/firmware/qemu_fw_cfg/by_name/opt/omni/net_allowlist/raw)
fi

# Apply network isolation if allowlist is set.
if [[ -n "${ALLOWLIST}" ]]; then
    export OMNI_SANDBOX_NETWORK_ALLOWLIST="${ALLOWLIST}"
    if [[ -f /usr/local/bin/apply-network-isolation.sh ]]; then
        source /usr/local/bin/apply-network-isolation.sh
    fi
fi

# Start PostgreSQL.
postgres_data_dir="/var/lib/postgresql/data"
postgres_bin_dir="$(pg_config --bindir 2>/dev/null || echo /usr/lib/postgresql/16/bin)"

if [[ -d "${postgres_bin_dir}" ]]; then
    mkdir -p "${postgres_data_dir}"
    chown -R postgres:postgres "${postgres_data_dir}"

    if [[ ! -f "${postgres_data_dir}/PG_VERSION" ]]; then
        gosu postgres "${postgres_bin_dir}/initdb" \
            -D "${postgres_data_dir}" \
            --encoding=UTF8 --locale=C.UTF-8 >/dev/null 2>&1
    fi

    gosu postgres "${postgres_bin_dir}/pg_ctl" -D "${postgres_data_dir}" \
        -o "-c listen_addresses=127.0.0.1 -p 5432" \
        -w start >/dev/null 2>&1 || true

    # Create default database + pgvector.
    for _ in $(seq 1 30); do
        gosu postgres "${postgres_bin_dir}/pg_isready" -h 127.0.0.1 >/dev/null 2>&1 && break
        sleep 0.2
    done

    gosu postgres "${postgres_bin_dir}/psql" -v ON_ERROR_STOP=0 -d postgres -c "
        DO \$\$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '"'"'postgres'"'"') THEN
                CREATE ROLE postgres WITH LOGIN SUPERUSER PASSWORD '"'"'password'"'"';
            END IF;
        END \$\$;
        SELECT 'CREATE DATABASE app_dev OWNER postgres' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'app_dev')\gexec
        SELECT 'CREATE DATABASE app_test OWNER postgres' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'app_test')\gexec
    " >/dev/null 2>&1 || true

    gosu postgres "${postgres_bin_dir}/psql" -d app_dev -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1 || true
    gosu postgres "${postgres_bin_dir}/psql" -d app_test -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null 2>&1 || true
fi

# Start Redis.
redis-server --bind 127.0.0.1 --port 6379 --protected-mode yes --daemonize yes >/dev/null 2>&1 || true

# Start code-server in background (if installed).
if command -v code-server >/dev/null 2>&1; then
    gosu 1000:1000 bash -lc "nohup code-server --bind-addr 0.0.0.0:8080 --auth none /home/user/workspace > /tmp/code-server.log 2>&1 &" || true
fi

# Ensure git trusts the workspace.
gosu 1000:1000 git config --global --add safe.directory /home/user/workspace 2>/dev/null || true

# Signal readiness.
echo "OMNI_VM_READY" > /dev/ttyS0

# Start the omni agent as the unprivileged user (foreground, PID 1 behavior).
exec gosu 1000:1000 bash -lc "exec omni --mode server --host 0.0.0.0 --port 7681"
VMEOF
        chmod +x /mnt/rootfs/usr/local/bin/omni-vm-init

        # Create a systemd service to run the init script on boot.
        mkdir -p /mnt/rootfs/etc/systemd/system
        cat > /mnt/rootfs/etc/systemd/system/omni-vm.service << "SVCEOF"
[Unit]
Description=Omni VM Init
After=network.target
DefaultDependencies=no

[Service]
Type=simple
ExecStart=/usr/local/bin/omni-vm-init
StandardOutput=journal+console
StandardError=journal+console
Restart=no

[Install]
WantedBy=multi-user.target
SVCEOF

        # Enable the service.
        ln -sf /etc/systemd/system/omni-vm.service \
            /mnt/rootfs/etc/systemd/system/multi-user.target.wants/omni-vm.service 2>/dev/null || true

        # Disable unnecessary services to speed up boot.
        for svc in snapd snapd.socket snapd.seeded apt-daily.timer apt-daily-upgrade.timer \
                    motd-news.timer fwupd.service ModemManager.service networkd-dispatcher.service \
                    multipathd.service; do
            rm -f "/mnt/rootfs/etc/systemd/system/multi-user.target.wants/${svc}" 2>/dev/null || true
            rm -f "/mnt/rootfs/etc/systemd/system/timers.target.wants/${svc}" 2>/dev/null || true
        done

        # Set hostname.
        echo "omni-sandbox" > /mnt/rootfs/etc/hostname

        # Configure autologin on ttyS0 for serial console.
        mkdir -p /mnt/rootfs/etc/systemd/system/serial-getty@ttyS0.service.d
        cat > /mnt/rootfs/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf << "ALEOF"
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear %I 115200 linux
ALEOF

        # Ensure /etc/fstab is minimal.
        cat > /mnt/rootfs/etc/fstab << "FSTAB"
# /etc/fstab — omni-sandbox VM
/dev/vda  /  ext4  defaults,noatime  0  1
FSTAB

        umount /mnt/rootfs
    '

# ---------------------------------------------------------------------------
# Step 5: Compress and generate manifest
# ---------------------------------------------------------------------------
echo "==> Step 5: Compressing rootfs..."

zstd -19 --rm -f "${ROOTFS}" -o "${OUTPUT_DIR}/rootfs.ext4.zst"

# Keep an uncompressed copy for local testing.
zstd -d "${OUTPUT_DIR}/rootfs.ext4.zst" -o "${ROOTFS}" --keep 2>/dev/null || true

echo "==> Step 6: Generating manifest..."

rootfs_hash=$(sha256sum "${ROOTFS}" | cut -d' ' -f1)
kernel_hash=$(sha256sum "${OUTPUT_DIR}/vmlinuz" | cut -d' ' -f1)
initrd_hash=$(sha256sum "${OUTPUT_DIR}/initrd.img" | cut -d' ' -f1)
rootfs_size=$(stat -c%s "${ROOTFS}" 2>/dev/null || stat -f%z "${ROOTFS}" 2>/dev/null)

cat > "${OUTPUT_DIR}/manifest.json" << EOF
{
    "version": "1.0.0",
    "arch": "${ARCH}",
    "omni_code_version": "${OMNI_CODE_VERSION}",
    "rootfs_sha256": "${rootfs_hash}",
    "kernel_sha256": "${kernel_hash}",
    "initrd_sha256": "${initrd_hash}",
    "rootfs_size_bytes": ${rootfs_size},
    "downloaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==> VM image built successfully!"
echo ""
echo "    Output directory: ${OUTPUT_DIR}"
echo ""
ls -lh "${OUTPUT_DIR}/vmlinuz" "${OUTPUT_DIR}/initrd.img" "${OUTPUT_DIR}/rootfs.ext4" "${OUTPUT_DIR}/rootfs.ext4.zst" "${OUTPUT_DIR}/manifest.json" 2>/dev/null
echo ""
echo "    To test locally:"
echo "      omni-sandbox vm run --workspace /path/to/project --image-dir ${OUTPUT_DIR}"
