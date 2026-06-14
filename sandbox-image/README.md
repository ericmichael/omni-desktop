# Devbox sandbox image

The Dockerfile + entrypoint + helper scripts that build the **devbox**
sandbox image — the Docker-backed sandbox profile shipped with the
launcher.

## Layout

| File                         | Purpose                                                                    |
| ---------------------------- | -------------------------------------------------------------------------- |
| `Dockerfile`                 | Image definition (postgres, redis, code-server, VNC stack, runtimes)       |
| `entrypoint.sh`              | UID/GID remap, infra startup, gitconfig persistence                        |
| `start-vnc.sh`               | Spawns Xvfb + XFCE + x11vnc + noVNC. Invoked by `omni serve` as a service. |
| `apply-network-isolation.sh` | Applies `OMNI_SANDBOX_NETWORK_ALLOWLIST` via iptables on boot.             |

## Building

```bash
docker build -t ghcr.io/<org>/omni-launcher-devbox:dev .
```

For local dev:

```bash
docker build -t omni-launcher-devbox:local .
```

Then point `assets/profiles/devbox.yml` at the local tag temporarily.

## Architecture note (Shape B)

Under the v22 launcher cut, the agent runs **on the host** (`omni serve`)
and uses a `SandboxSession` to drive workspace operations inside this
container. Services like code-server and VNC are no longer started by the
container's entrypoint — instead, `omni serve` launches them via
`session.pty_exec_start` based on the `services:` block in the profile
YAML. The entrypoint's job is just to:

1. Remap the in-container `user` to the host UID/GID
2. Boot stateful infra (postgres, redis)
3. Apply network isolation rules
4. Restore persisted gitconfig
5. `exec gosu "$@"` so the container's CMD (default `sleep infinity`)
   keeps it alive long enough for the session to attach.

The old `omni-code/omni_code/sandbox/` location is being retired — once
the launcher CI publishes images from this directory and the
`devbox.yml` profile points at the new tag, the omni-code copy can be
removed.
