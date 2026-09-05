# Codex WebApp: Human Setup Guide

[English project README](README.md) | [简体中文项目说明](README.zh-CN.md)

This document contains the manual installation, configuration, deployment, security, upgrade, and troubleshooting information for people who want to operate Codex WebApp themselves. For the shorter project overview and the recommended Codex configuration prompt, see the main [README](README.md).

## Overview

Codex WebApp is a self-hosted mobile console. Codex runs on the local machine, while a phone or desktop browser connects to the local `codex-console` daemon. The daemon starts the official `codex app-server` over stdio and does not expose the app-server directly to the network.

```text
Phone / desktop browser
              | HTTP + WebSocket
              v
codex-console daemon
              | stdin/stdout JSONL
              v
official codex app-server -> local projects and tools
```

> This project is unofficial and is not affiliated with or endorsed by OpenAI.

## Requirements

- Linux or macOS. The user-level systemd deployment below requires Linux.
- Node.js 20 or newer and npm 10 or newer.
- The official Codex CLI installed and logged in for the same user that runs the daemon.
- Git.
- A network path from your phone to the server: local LAN, Tailscale, VPN, or an HTTPS reverse proxy.

## Manual Installation

From the repository root:

```bash
npm install
npm run build
npm run start -- password set
npm run start
```

The password is stored as an Argon2id hash. It must contain at least 12 characters. Do not put it in shell history, `.env`, Git, logs, or a service file.

By default the daemon listens only on `http://127.0.0.1:8787`. To access it from a phone on the LAN:

```bash
CODEX_CONSOLE_HOST=0.0.0.0 npm run start
```

Open the server's LAN address on the phone, for example `http://192.168.1.20:8787`. Use `hostname -I` to inspect local addresses when needed.

For development, run the Vite frontend and daemon together:

```bash
npm run dev
```

Vite uses `http://127.0.0.1:5173` and proxies API/WebSocket traffic to port `8787`.

## Configuration

Configuration is supplied through environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `CODEX_CONSOLE_HOST` | `127.0.0.1` | HTTP bind address. Use `0.0.0.0` only when LAN/VPN/HTTPS access is intentional. |
| `CODEX_CONSOLE_PORT` | `8787` | HTTP and WebSocket port. |
| `CODEX_CONSOLE_ORIGIN` | empty | When set, only the exact browser Origin is accepted. |
| `CODEX_CONSOLE_DATA_DIR` | `~/.local/state/codex-console` | Password hash, session state, and uploaded attachments. |
| `CODEX_CWD` | daemon startup directory | Default working directory for new threads and Codex. |
| `CODEX_WORKSPACE_ROOT` | parent of `CODEX_CWD` | Boundary for project browsing and new directories. |
| `CODEX_COMMAND` | `codex` | Codex executable. Use an absolute path with version managers. |
| `CODEX_CONSOLE_SHELL` | `$SHELL` or `/bin/bash` | Shell executable used by the direct command window. |
| `CODEX_CONSOLE_SESSION_DAYS` | `7` | Session lifetime in days. |
| `LOG_LEVEL` | `info` | Fastify log level. |

Example:

```bash
CODEX_CWD=/srv/projects/demo \
CODEX_WORKSPACE_ROOT=/srv/projects \
CODEX_CONSOLE_HOST=0.0.0.0 \
CODEX_CONSOLE_PORT=8787 \
npm run start
```

The workspace browser stays inside `CODEX_WORKSPACE_ROOT`. The Files panel can upload files directly to the current directory and copy each file's server-side absolute path. Text previews are limited to 5 MiB, individual uploads to 25 MiB, and each message to eight attachments.

### Custom models and providers

The Settings dialog can store additional model identifiers that are not returned by the installed Codex version's `model/list` response. Custom entries are saved in the daemon state outside the repository and appear in the default-model, new-thread, and composer selectors on every device.

The WebApp stores only the model identifier and an optional display name. It passes the identifier unchanged through the local app-server's `thread/start` and `turn/start` requests. Configure third-party API base URLs, providers, and credentials in the local Codex CLI configuration supported by your installed Codex version. Do not enter API keys in the model-name field or store them in WebApp state. A custom name does not make an unsupported provider available by itself; the local Codex configuration must already be able to resolve it.

### Workspace commands

The right context sidebar includes a direct shell-command window rooted at the current thread directory. It invokes `CODEX_CONSOLE_SHELL -c <command>` and supports any command available to the daemon's operating-system user, including pipes, redirection, command chaining, scripts, network clients, and mutating commands. These commands do not pass through Codex and do not use the Codex approval flow.

This is a non-interactive shell rather than a PTY: programs that require terminal input, full-screen rendering, or password prompts may not work. Each command has a 10-minute timeout and a combined 1 MiB output limit, with at most two commands running concurrently. The UI can terminate the command's process group.

`CODEX_WORKSPACE_ROOT` validates only the initial thread working directory. Once the shell starts, a command can use absolute paths or `cd` to access anything permitted to the daemon's OS user. Treat access to Codex WebApp as equivalent to shell access to that account.

## Background Service on Linux

The repository includes `deploy/codex-console.service`, a reusable user-level systemd template. It assumes the checkout is `~/Codex-WebApp` and that `node` and `codex` are in `PATH`. For any other installation, keep machine-specific values outside Git in `~/.config/codex-console/environment`:

```bash
mkdir -p ~/.config/codex-console
${EDITOR:-vi} ~/.config/codex-console/environment
chmod 600 ~/.config/codex-console/environment
```

At minimum, set `CODEX_CONSOLE_REPO`, `CODEX_NODE`, `CODEX_CWD`, `CODEX_WORKSPACE_ROOT`, and `CODEX_COMMAND` to values valid on the machine. Set `CODEX_CONSOLE_HOST=0.0.0.0` only when phone access is needed.

Install and start the service:

```bash
mkdir -p ~/.config/systemd/user
ln -sfn "$PWD/deploy/codex-console.service" \
  ~/.config/systemd/user/codex-console.service
systemctl --user daemon-reload
systemctl --user enable --now codex-console.service
```

Useful commands:

```bash
systemctl --user status codex-console.service
journalctl --user -u codex-console.service -f
systemctl --user stop codex-console.service
systemctl --user restart codex-console.service
```

The service uses `Restart=always`. Authentication state is normally stored in `~/.local/state/codex-console`. To keep a user service running after logout, enable linger if appropriate:

```bash
loginctl enable-linger "$USER"
```

Restarting the service terminates the app-server Turn owned by that daemon. Wait for important work to finish or interrupt it from the UI before restarting. The same caution applies when another local Codex CLI is running an important Turn.

The external Turn detector reads rollout links through `/proc/<pid>/fd` for the same user. Do not add systemd options such as `PrivateTmp=true` or `ProtectSystem=true`, which create an isolated mount namespace and break that detection.

## Security

- Do not expose port `8787` directly to the public Internet. Prefer Tailscale/VPN or an HTTPS reverse proxy.
- Plain LAN HTTP is not encrypted. Use HTTPS for anything beyond a trusted private network.
- Never commit `.env`, state files, uploaded attachments, cookies, tokens, SSH keys, or Codex credentials.
- Keep `CODEX_WORKSPACE_ROOT` as narrow as practical.
- The authenticated command window can execute arbitrary shell commands as the daemon's OS user without Codex approval. Do not expose the service directly to the public Internet, use a strong unique password, and protect it with a VPN/Tailscale or HTTPS.
- Keep the app-server on stdio; do not configure a public app-server listener.

## Development, Tests, and Protocol Updates

```bash
npm run build
npm test
npm audit --omit=dev
```

`codex app-server` is an experimental interface. After upgrading the Codex CLI, regenerate protocol artifacts for the installed version and rebuild:

```bash
npm run codex:schema
npm run build
```

Generated files are placed under `generated/codex` and are ignored because they depend on the local Codex version. See [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md) for the adapter and compatibility model.

## Troubleshooting

Check the local health endpoint first:

```bash
curl -sS http://127.0.0.1:8787/api/healthz
```

- **Login fails:** run `npm run start -- password set` on the server and make sure it uses the same `CODEX_CONSOLE_DATA_DIR` as the service.
- **Models or threads cannot load:** verify `codex --version`, Codex login status, `CODEX_COMMAND`, and the systemd journal.
- **The phone cannot connect:** verify the bind address, firewall, network isolation, and the correct LAN address and port.
- **External activity is not detected:** run the daemon and Codex CLI as the same Linux user and keep `PrivateTmp`/`ProtectSystem` disabled.
- **Protocol errors after an upgrade:** run `npm run codex:schema`, rebuild, and inspect the Codex version and method names in the logs.

## Documentation

- [Project overview and Codex prompt](README.md)
- [简体中文项目说明](README.zh-CN.md)
- [Codex automated setup instructions](docs/CODEX_SETUP.md)
- [Repository instructions for Codex](AGENTS.md)
- [Technical design](docs/TECHNICAL_DESIGN.md)

## License

This repository currently does not include an open-source license. Until the owner adds one, the code remains subject to the default rights under applicable copyright law.
