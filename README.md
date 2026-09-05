# Codex WebApp

[简体中文](README.zh-CN.md)

An open-source, self-hosted web console for controlling Codex from a phone or desktop browser while Codex keeps running on your local machine.

> This project is unofficial and is not affiliated with or endorsed by OpenAI.

<img width="2552" height="1340" alt="image" src="https://github.com/user-attachments/assets/4257dc7e-883f-4cac-8bb6-dcad3cefdc60" />
<img width="2547" height="1337" alt="image" src="https://github.com/user-attachments/assets/5802f8a8-3d63-43a8-8213-c255b7168460" />


## What It Does

Codex WebApp runs a local daemon that starts and supervises the official `codex app-server` over stdio. The browser connects to the daemon through authenticated HTTP and WebSocket endpoints. No cloud relay is required.

```text
Phone / desktop browser
          |
          | HTTP + WebSocket
          v
codex-console daemon
          |
          | stdin/stdout JSONL
          v
official codex app-server -> local projects and tools
```

## Features

- Responsive Codex-style conversation UI for phones, tablets, and desktops.
- Password login with Argon2id password hashing and HttpOnly session cookies.
- Create, resume, fork, archive, and switch between local project threads.
- Live Turn status, approval prompts, user-input requests, and external Codex activity detection.
- Interrupt active Turns, send follow-up instructions while a Turn is running, and queue later instructions per thread.
- Edit and resend the latest user message.
- Separate user, execution-progress, and final-answer messages, with collapsible execution details.
- Markdown/GFM and LaTeX/KaTeX rendering.
- Live Codex model discovery plus persistent custom model names for locally configured third-party providers.
- Per-thread model selection, image/file/audio attachments, and desktop clipboard paste for images and files.
- Authenticated workspace browsing, upload to the current directory, line-numbered text preview, media/PDF preview, file links, and copy-absolute-path actions.
- Independently collapsible desktop sidebars and a bounded, read-only command panel for the current workspace path.
- Light/dark themes and installable PWA support.

## Configure With Codex

The intended setup path is to give this repository to your own Codex and let it inspect the machine before installing anything. Send it the repository URL and ask it to follow the repository instructions:

```text
Please configure Codex WebApp on this machine.

Repository: https://github.com/bianyh/Codex-WebApp

First read AGENTS.md, README.md, docs/CODEX_SETUP.md, and
docs/TECHNICAL_DESIGN.md. Then inspect the local Node.js and Codex CLI
installation, verify that Codex is logged in, install dependencies, build,
run the tests, ask me to set the login password, and configure the daemon
for my chosen workspace. On Linux, install the user-level systemd service
only after checking for existing services and active Codex Turns.

Do not print or commit passwords, tokens, cookies, API keys, private keys,
uploaded files, or machine-specific secrets. Do not restart or interrupt an
active important Turn without asking me first. Report the final local/LAN
URL, service status, health-check result, and validation commands.
```

Codex-specific execution rules are in [AGENTS.md](AGENTS.md), and the detailed automated setup procedure is in [docs/CODEX_SETUP.md](docs/CODEX_SETUP.md).

## Human Documentation

For manual installation, environment variables, systemd deployment, security guidance, upgrades, and troubleshooting, read [README4HUMAN.md](README4HUMAN.md).

The architecture and protocol design are documented in [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md).

## License

This repository currently does not include an open-source license. Until the owner adds one, the code remains subject to the default rights under applicable copyright law.
