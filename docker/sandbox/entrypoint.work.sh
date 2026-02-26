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

vnc_enabled="${OMNI_CODE_VNC:-0}"
if [[ "${vnc_enabled}" == "1" || "${vnc_enabled}" == "true" ]]; then
  # Create directories needed by X11/ICE session management
  mkdir -p /tmp/.ICE-unix /tmp/.X11-unix
  chmod 1777 /tmp/.ICE-unix /tmp/.X11-unix

  # Run the entire VNC stack as the mapped user (dbus, Xvfb, XFCE, x11vnc,
  # noVNC all in one user context — avoids privilege-switching dbus issues)
  gosu "${uid}:${gid}" bash /usr/local/bin/start-vnc.sh
fi

code_server_enabled="${OMNI_CODE_CODE_SERVER:-0}"
if [[ "${code_server_enabled}" == "1" || "${code_server_enabled}" == "true" ]]; then
  code_server_port="${CODE_SERVER_PORT:-8080}"
  code_server_auth="${CODE_SERVER_AUTH:-password}"
  code_server_workspace="${CODE_SERVER_WORKSPACE:-/home/user/workspace}"
  code_server_log_dir="${CODE_SERVER_LOG_DIR:-/home/user/.local/share/code-server}"
  mkdir -p "${code_server_log_dir}" >/dev/null 2>&1 || true
  chown -R "${uid}:${gid}" "${code_server_log_dir}" >/dev/null 2>&1 || true
  mkdir -p "${HOME}/.config" >/dev/null 2>&1 || true
  chown -R "${uid}:${gid}" "${HOME}/.config" >/dev/null 2>&1 || true

  gosu "${uid}:${gid}" bash -lc "nohup code-server --bind-addr 0.0.0.0:${code_server_port} --auth ${code_server_auth} ${code_server_workspace} > '${code_server_log_dir}/omni-code.log' 2>&1 &" || true
fi

# Apply network isolation rules (if OMNI_SANDBOX_NETWORK_ALLOWLIST is set)
source /usr/local/bin/apply-network-isolation.sh

exec gosu "${uid}:${gid}" "$@"
