#!/usr/bin/env bash
# Minimal entrypoint for the thin devbox image. Sets up the unprivileged
# `user`, restores/persists gitconfig, applies optional network isolation, then
# drops privileges. Unlike the full image's entrypoint it brings up NO services
# (no postgres/redis/desktop) — the minimal image doesn't ship them, and the
# agent drives everything via `exec`. (In ACI the container group's command
# replaces this entrypoint entirely; it matters only under Docker.)
set -euo pipefail

uid="${LOCAL_UID:-1000}"
gid="${LOCAL_GID:-1000}"

existing_user_name=""
if getent passwd "${uid}" >/dev/null 2>&1; then
  existing_user_name="$(getent passwd "${uid}" | cut -d: -f1)"
fi

existing_group_name=""
if getent group "${gid}" >/dev/null 2>&1; then
  existing_group_name="$(getent group "${gid}" | cut -d: -f1)"
fi

group_name="${existing_group_name:-hostgroup}"
if ! getent group "${group_name}" >/dev/null 2>&1; then
  groupadd -g "${gid}" "${group_name}"
fi

if [[ -z "${existing_user_name}" ]]; then
  if id -u user >/dev/null 2>&1; then
    usermod -u "${uid}" -g "${gid}" user >/dev/null 2>&1 || true
  else
    useradd -m -u "${uid}" -g "${gid}" -s /bin/bash user
  fi
elif [[ "${existing_user_name}" != "user" ]]; then
  usermod -l user -d /home/user -m "${existing_user_name}" >/dev/null 2>&1 || true
fi

export HOME=/home/user
mkdir -p "${HOME}"
chown "${uid}:${gid}" "${HOME}" >/dev/null 2>&1 || true

# Restore persisted gitconfig from the volume directory, trust the workspace,
# then persist it back for next restart.
if [[ -f "${HOME}/.gitconfig.d/gitconfig" ]]; then
  cp "${HOME}/.gitconfig.d/gitconfig" "${HOME}/.gitconfig"
  chown "${uid}:${gid}" "${HOME}/.gitconfig" >/dev/null 2>&1 || true
fi
gosu "${uid}:${gid}" git config --global --add safe.directory /home/user/workspace
mkdir -p "${HOME}/.gitconfig.d" >/dev/null 2>&1 || true
cp "${HOME}/.gitconfig" "${HOME}/.gitconfig.d/gitconfig" 2>/dev/null || true

# Apply network isolation rules (if OMNI_SANDBOX_NETWORK_ALLOWLIST is set).
source /usr/local/bin/apply-network-isolation.sh

exec gosu "${uid}:${gid}" "$@"
