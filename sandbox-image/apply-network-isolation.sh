#!/usr/bin/env bash
# apply-network-isolation.sh
#
# Restricts container outbound traffic to an allowlist of hosts/CIDRs.
# Sourced by entrypoint scripts while still running as root, before
# dropping privileges with gosu. The unprivileged user cannot undo
# these rules because it lacks CAP_NET_ADMIN.
#
# Set OMNI_SANDBOX_NETWORK_ALLOWLIST to a comma-separated list of
# hostnames, IP addresses, or CIDR ranges. If unset or empty, no
# restrictions are applied.

allowlist="${OMNI_SANDBOX_NETWORK_ALLOWLIST:-}"

if [[ -z "${allowlist}" ]]; then
  return 0 2>/dev/null || exit 0
fi

# Allow all traffic on loopback
iptables -A OUTPUT -o lo -j ACCEPT

# Allow responses to already-established connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS resolution so hostnames in the allowlist can be resolved
# at runtime (e.g. by curl, pip, etc. inside the container)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Allow traffic to the Docker host gateway (host.docker.internal) so the
# container can reach host-side services like launcher MCP servers.
host_gw="$(getent ahosts host.docker.internal 2>/dev/null | awk '{print $1}' | head -n1)" || true
if [[ -n "${host_gw}" ]]; then
  iptables -A OUTPUT -d "${host_gw}" -j ACCEPT
fi

# Process each entry in the allowlist
IFS=',' read -ra ENTRIES <<< "${allowlist}"
for entry in "${ENTRIES[@]}"; do
  entry="$(echo "${entry}" | xargs)"  # trim whitespace
  [[ -z "${entry}" ]] && continue

  if [[ "${entry}" == *"/"* ]]; then
    # CIDR range — allow directly
    iptables -A OUTPUT -d "${entry}" -j ACCEPT
  else
    # Hostname or bare IP — resolve and allow each address
    resolved="$(getent ahosts "${entry}" 2>/dev/null | awk '{print $1}' | sort -u)" || true
    if [[ -n "${resolved}" ]]; then
      for ip in ${resolved}; do
        iptables -A OUTPUT -d "${ip}" -j ACCEPT
      done
    else
      # If resolution fails, try it as a literal (bare IP that isn't in DNS)
      iptables -A OUTPUT -d "${entry}" -j ACCEPT 2>/dev/null || \
        echo "WARNING: could not resolve or add allowlist entry: ${entry}" >&2
    fi
  fi
done

# Block everything else
iptables -A OUTPUT -j REJECT --reject-with icmp-net-prohibited
iptables -P OUTPUT DROP

echo "Network isolation active: outbound traffic restricted to allowlist" >&2
