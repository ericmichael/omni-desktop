FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

ARG CODE_SERVER_VERSION=4.109.2
ARG LEAN_VERSION=4.27.0

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git \
    sudo \
    python3 \
    python3-pip \
    python3-venv \
    pipx \
    nodejs \
    npm \
    ripgrep \
    fd-find \
    jq \
    sqlite3 \
    ffmpeg \
    pandoc \
    imagemagick \
    latexmk \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    zstd \
    build-essential \
    pkg-config \
    libgit2-dev \
    gosu \
    iptables \
    # VNC desktop support (activated via OMNI_CODE_VNC=1)
    xvfb \
    xfce4 \
    xfce4-goodies \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    dbus-x11 \
    software-properties-common \
    && rm -rf /var/lib/apt/lists/*

# Install Firefox from Mozilla PPA (Ubuntu 24.04 only has a snap stub)
RUN add-apt-repository -y ppa:mozillateam/ppa \
    && echo 'Package: *\nPin: release o=LP-PPA-mozillateam\nPin-Priority: 1001' > /etc/apt/preferences.d/mozilla-firefox \
    && apt-get update \
    && apt-get install -y firefox \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fOL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${ARCH}.deb" \
    && apt-get update \
    && apt-get install -y "./code-server_${CODE_SERVER_VERSION}_${ARCH}.deb" \
    && rm -f "code-server_${CODE_SERVER_VERSION}_${ARCH}.deb" \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

ENV PIPX_HOME=/opt/pipx
ENV PIPX_BIN_DIR=/usr/local/bin
ENV ELAN_HOME=/opt/elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"

RUN curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain "leanprover/lean4:v${LEAN_VERSION}" \
    && elan --version \
    && lean --version \
    && lake --version

RUN pipx install omni-code --pip-args='--extra-index-url https://pypi.fury.io/ericmichael/'

RUN npm install -g @playwright/cli@0.1.1

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

RUN mkdir -p "${PLAYWRIGHT_BROWSERS_PATH}" \
    && python3 -m pip install --no-cache-dir --break-system-packages playwright \
    && python3 -m playwright install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
    && rm -rf /var/lib/apt/lists/*

RUN cat > /usr/local/bin/chrome-binary <<'SH'
#!/bin/sh

set -eu

if [ -n "${CHROME_BINARY_REAL:-}" ] && [ -x "${CHROME_BINARY_REAL}" ]; then
  exec "${CHROME_BINARY_REAL}" "$@"
fi

PLAYWRIGHT_CHROME=""
if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  PLAYWRIGHT_CHROME=$(ls -1 "${PLAYWRIGHT_BROWSERS_PATH}"/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -n 1 || true)
fi

if [ -n "${PLAYWRIGHT_CHROME}" ] && [ -x "${PLAYWRIGHT_CHROME}" ]; then
  exec "${PLAYWRIGHT_CHROME}" "$@"
fi

if [ -n "${HOME:-}" ]; then
  PLAYWRIGHT_CHROME=$(ls -1 "${HOME}/.cache/ms-playwright"/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -n 1 || true)
fi

if [ -n "${PLAYWRIGHT_CHROME}" ] && [ -x "${PLAYWRIGHT_CHROME}" ]; then
  exec "${PLAYWRIGHT_CHROME}" "$@"
fi

for candidate in \
  /usr/bin/google-chrome \
  /usr/bin/google-chrome-stable \
  /opt/google/chrome/chrome \
  /usr/bin/chromium \
  /usr/bin/chromium-browser \
  ; do
  if [ -x "${candidate}" ]; then
    exec "${candidate}" "$@"
  fi
done

echo "No Chrome/Chromium binary found" >&2
exit 1
SH

RUN chmod +x /usr/local/bin/chrome-binary

ENV CHROME_BINARY=/usr/local/bin/chrome-binary

ENV PLAYWRIGHT_MCP_BROWSER=chromium
ENV PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/local/bin/chrome-binary
ENV PLAYWRIGHT_MCP_SANDBOX=false

COPY entrypoint.sh /usr/local/bin/omni-sandbox-entrypoint
RUN chmod +x /usr/local/bin/omni-sandbox-entrypoint

COPY apply-network-isolation.sh /usr/local/bin/apply-network-isolation.sh
RUN chmod +x /usr/local/bin/apply-network-isolation.sh

COPY start-vnc.sh /usr/local/bin/start-vnc.sh
RUN chmod +x /usr/local/bin/start-vnc.sh

ENV OMNI_WEB_AUTO_OPEN=false
EXPOSE 7681
EXPOSE 8080
EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/omni-sandbox-entrypoint"]
CMD ["omni", "--mode", "server", "--host", "0.0.0.0", "--port", "7681"]
