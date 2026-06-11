#!/usr/bin/env bash
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

postgres_data_dir="${POSTGRES_DATA_DIR:-/var/lib/postgresql/data}"
postgres_bin_dir="$(pg_config --bindir)"

mkdir -p "${postgres_data_dir}"
chown -R postgres:postgres "${postgres_data_dir}"

if [[ ! -f "${postgres_data_dir}/PG_VERSION" ]]; then
  gosu postgres "${postgres_bin_dir}/initdb" \
    -D "${postgres_data_dir}" \
    --encoding=UTF8 \
    --locale=C.UTF-8
fi

gosu postgres "${postgres_bin_dir}/pg_ctl" -D "${postgres_data_dir}" \
  -o "-c listen_addresses=${POSTGRES_HOST:-127.0.0.1} -p ${POSTGRES_PORT:-5432}" \
  -w start

server_encoding="$(gosu postgres "${postgres_bin_dir}/psql" -At -d postgres -c "SHOW server_encoding;" 2>/dev/null || true)"
if [[ "${server_encoding}" != "UTF8" ]]; then
  gosu postgres "${postgres_bin_dir}/pg_ctl" -D "${postgres_data_dir}" -m fast -w stop
  rm -rf "${postgres_data_dir}"/*
  gosu postgres "${postgres_bin_dir}/initdb" \
    -D "${postgres_data_dir}" \
    --encoding=UTF8 \
    --locale=C.UTF-8
  gosu postgres "${postgres_bin_dir}/pg_ctl" -D "${postgres_data_dir}" \
    -o "-c listen_addresses=${POSTGRES_HOST:-127.0.0.1} -p ${POSTGRES_PORT:-5432}" \
    -w start
fi

for _ in $(seq 1 60); do
  if gosu postgres "${postgres_bin_dir}/pg_isready" -h "${POSTGRES_HOST:-127.0.0.1}" -p "${POSTGRES_PORT:-5432}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

gosu postgres "${postgres_bin_dir}/psql" -v ON_ERROR_STOP=1 -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${POSTGRES_USER:-postgres}') THEN
    CREATE ROLE ${POSTGRES_USER:-postgres} WITH LOGIN SUPERUSER PASSWORD '${POSTGRES_PASSWORD:-password}';
  ELSE
    ALTER ROLE ${POSTGRES_USER:-postgres} WITH PASSWORD '${POSTGRES_PASSWORD:-password}';
  END IF;
END
\$\$;
SQL

gosu postgres "${postgres_bin_dir}/psql" -v ON_ERROR_STOP=1 -d postgres <<SQL
SELECT 'CREATE DATABASE "' || '${POSTGRES_DB:-app_dev}' || '" OWNER ${POSTGRES_USER:-postgres}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${POSTGRES_DB:-app_dev}')\gexec
SELECT 'CREATE DATABASE "' || '${POSTGRES_TEST_DB:-app_test}' || '" OWNER ${POSTGRES_USER:-postgres}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${POSTGRES_TEST_DB:-app_test}')\gexec
SQL

gosu postgres "${postgres_bin_dir}/psql" -v ON_ERROR_STOP=1 -d "${POSTGRES_DB:-app_dev}" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
gosu postgres "${postgres_bin_dir}/psql" -v ON_ERROR_STOP=1 -d "${POSTGRES_TEST_DB:-app_test}" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

redis-server --bind 127.0.0.1 --port 6379 --protected-mode yes --daemonize yes

export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

export BUNDLE_PATH="${BUNDLE_PATH:-${HOME}/.bundle}"
mkdir -p "${BUNDLE_PATH}" >/dev/null 2>&1 || true

# Pre-create directories code-server/VNC will need when omni serve launches
# them as ``services:`` (so the pty_exec_start commands don't fail on
# missing config/log paths). The actual processes start later via omni
# serve's pty_exec_start — not from this entrypoint.
mkdir -p /tmp/.ICE-unix /tmp/.X11-unix
chmod 1777 /tmp/.ICE-unix /tmp/.X11-unix
mkdir -p "${HOME}/.config/xfce4/xfconf/xfce-perchannel-xml"
mkdir -p "${HOME}/.local/share/code-server"
chown -R "${uid}:${gid}" "${HOME}/.config" "${HOME}/.local" 2>/dev/null || true

# Restore persisted gitconfig from volume directory
if [[ -f "${HOME}/.gitconfig.d/gitconfig" ]]; then
  cp "${HOME}/.gitconfig.d/gitconfig" "${HOME}/.gitconfig"
  chown "${uid}:${gid}" "${HOME}/.gitconfig" >/dev/null 2>&1 || true
fi

# Ensure git trusts the bind-mounted workspace
gosu "${uid}:${gid}" git config --global --add safe.directory /home/user/workspace

# Persist gitconfig back to the volume for next restart
mkdir -p "${HOME}/.gitconfig.d" >/dev/null 2>&1 || true
cp "${HOME}/.gitconfig" "${HOME}/.gitconfig.d/gitconfig" 2>/dev/null || true

# Apply network isolation rules (if OMNI_SANDBOX_NETWORK_ALLOWLIST is set)
source /usr/local/bin/apply-network-isolation.sh

exec gosu "${uid}:${gid}" "$@"
