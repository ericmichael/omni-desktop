#!/usr/bin/env bash
# VNC desktop startup script — runs entirely as the unprivileged user.
# Modeled after the proven nn-desktop start.sh approach.
set -euo pipefail

vnc_port="${VNC_PORT:-6080}"
display_width="${VNC_DISPLAY_WIDTH:-1024}"
display_height="${VNC_DISPLAY_HEIGHT:-768}"

# Resolve HOME from passwd so it matches what XFCE expects, and clear
# XDG_CONFIG_HOME so XFCE uses the default ($HOME/.config) consistently.
export HOME=$(getent passwd "$(id -u)" | cut -d: -f6)
unset XDG_CONFIG_HOME

log_dir="${HOME}/.local/share/vnc"
mkdir -p "${log_dir}"

export DISPLAY=:0

# Start dbus session bus
export DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address)

# Start Xvfb (virtual framebuffer)
Xvfb :0 -screen 0 "${display_width}x${display_height}x24" > "${log_dir}/xvfb.log" 2>&1 &
sleep 2

# Start XFCE desktop
startxfce4 > "${log_dir}/xfce4.log" 2>&1 &
sleep 2

# Start VNC server (no password, localhost only)
x11vnc -display :0 -forever -shared -nopw -listen localhost > "${log_dir}/x11vnc.log" 2>&1 &
sleep 1

# Start noVNC (websocket proxy to VNC) — runs in background
websockify --web=/usr/share/novnc "${vnc_port}" localhost:5900 > "${log_dir}/novnc.log" 2>&1 &
