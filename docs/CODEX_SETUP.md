# 给 Codex 的配置手册

本文件供另一个 Codex 在一台新机器上配置 Codex WebApp 时阅读和执行。目标是完成“本机 Codex + 本机 daemon + 手机浏览器”的部署，而不是把项目改造成云端服务。

执行任何写入、安装或服务重启前，先阅读仓库根目录的 `AGENTS.md` 和 `README.md`。不要输出实际密码、会话 Cookie、Token、SSH 密钥、代理凭据或 Codex 登录状态内容。

## 1. 识别环境

记录当前仓库的绝对路径和当前用户，但不要把它们写死到源代码中：

```bash
pwd
id -un
uname -srm
node --version
npm --version
codex --version
command -v node
command -v codex
```

项目要求 Node.js 20+。如果 `node` 或 `codex` 不存在，先停止并告诉用户需要安装对应工具；不要自动下载未知来源的二进制文件。若 Node/Codex 由 Volta、nvm 或其他版本管理器提供，记下后台服务需要使用的绝对路径。

确认 Codex CLI 已由当前用户完成登录。只检查命令的退出状态或版本信息，不读取、复制或打印 `~/.codex`、API key、Token 等认证文件。如果 Codex 未登录，要求用户先在本机完成官方登录流程。

## 2. 检查已有部署

先检查是否已有服务、监听端口和当前任务：

```bash
systemctl --user status codex-console.service --no-pager
ss -ltnp | rg ':8787\b' || true
curl -sS --max-time 3 http://127.0.0.1:8787/api/healthz || true
```

如果已有 `codex-console.service`，先确认它的 `WorkingDirectory`、`CODEX_CONSOLE_DATA_DIR` 和构建版本。不要因为配置文档被重新读取就直接重启服务。

如果健康接口显示 `activeThreads` 大于 0，或界面/日志表明 Codex 正在执行重要 Turn：

- 可以继续做只读检查和编辑文档；
- 不要执行 `systemctl --user restart`、杀掉 app-server 或覆盖状态目录；
- 等待 Turn 完成，或让用户明确确认中止/重启。

## 3. 安装、构建和测试

在仓库根目录执行：

```bash
npm install
npm run build
npm test
npm audit --omit=dev
```

任何一步失败都要保留错误摘要并先修复或向用户报告，不要启动一个未构建成功的生产服务。`npm run build` 会生成 `dist/web` 和 `apps/daemon/dist`；这些构建产物不提交到 Git。

## 4. 设置登录密码

密码由 daemon 使用 Argon2id 哈希保存到 `CODEX_CONSOLE_DATA_DIR`。让用户在本机交互式设置至少 12 个字符的密码：

```bash
npm run start -- password set
```

如果后台服务要使用非默认数据目录，设置密码时必须使用同一个环境变量：

```bash
CODEX_CONSOLE_DATA_DIR="$HOME/.local/state/codex-console" \
  npm run start -- password set
```

不要替用户生成、猜测、回显或记录密码，不要把密码作为命令行参数写进 shell 历史。更换密码使用 `password change`。

## 5. 选择工作区和监听地址

根据用户意图设置：

- `CODEX_CWD`：新线程默认工作目录，必须是实际存在的本机目录。
- `CODEX_WORKSPACE_ROOT`：文件浏览、新建文件夹和项目选择的根目录，通常是包含多个项目的父目录；应尽量小。
- `CODEX_CONSOLE_HOST`：默认 `127.0.0.1`。手机访问时通常设为 `0.0.0.0`，但这会开放到所有网卡，必须配合局域网/VPN/HTTPS 安全措施。
- `CODEX_CONSOLE_PORT`：默认 `8787`。端口冲突时先告诉用户并选择新端口，不要杀掉未知进程。
- `CODEX_COMMAND`：Codex 不在 `PATH` 时填写绝对可执行文件路径。
- `CODEX_CONSOLE_SHELL`：命令窗口使用的 Shell，默认取 `$SHELL`，否则为 `/bin/bash`。该窗口可绕过 Codex 审批执行 daemon 用户有权执行的任意命令，应只在受信网络中启用服务。
- `CODEX_CONSOLE_ORIGIN`：使用固定域名或反向代理时填写完整 Origin，例如 `https://codex.example.com`。

快速前台验证可以这样运行：

```bash
CODEX_CWD=/path/to/default-project \
CODEX_WORKSPACE_ROOT=/path/to/projects \
CODEX_CONSOLE_HOST=0.0.0.0 \
CODEX_CONSOLE_PORT=8787 \
CODEX_COMMAND=codex \
npm run start
```

验证完成后用 `Ctrl-C` 停止前台进程，再选择是否安装后台服务。不要在同一个端口启动第二个 daemon。

## 6. 安装用户级 systemd 服务（Linux）

`deploy/codex-console.service` 是模板，不是跨机器即用的二进制安装器。它默认假设仓库位于 `~/Codex-WebApp`，且 `node`、`codex` 位于 `PATH`。其他情况应在仓库之外创建环境覆盖文件，不要把本机绝对路径写回仓库：

```bash
mkdir -p "$HOME/.config/codex-console"
${EDITOR:-vi} "$HOME/.config/codex-console/environment"
chmod 600 "$HOME/.config/codex-console/environment"
```

至少设置实际的 `CODEX_CONSOLE_REPO`、`CODEX_NODE`、`CODEX_CWD`、`CODEX_WORKSPACE_ROOT` 和 `CODEX_COMMAND`；手机访问时设置 `CODEX_CONSOLE_HOST=0.0.0.0`。`CODEX_NODE` 和 `CODEX_COMMAND` 在使用 Volta、nvm 或其他版本管理器时应填写绝对路径。

```bash
mkdir -p "$HOME/.config/systemd/user"
ln -sfn "$PWD/deploy/codex-console.service" \
  "$HOME/.config/systemd/user/codex-console.service"
systemctl --user daemon-reload
systemctl --user enable --now codex-console.service
```

服务单元必须保持以下安全前提：

- `NoNewPrivileges=true` 和 `UMask=0077` 可以保留；
- 不要添加 `PrivateTmp=true` 或 `ProtectSystem=true`，因为外部 Turn 识别需要读取同一用户的 `/proc/<pid>/fd` rollout 链接；
- `codex app-server` 只通过 stdio 启动，不配置公网监听参数；
- 服务重启前再次检查活动 Turn。

启用后检查：

```bash
systemctl --user status codex-console.service --no-pager
curl -sS http://127.0.0.1:8787/api/healthz
journalctl --user -u codex-console.service -n 80 --no-pager
```

如果用户要求退出 SSH/桌面会话后仍运行，可以询问并执行：

```bash
loginctl enable-linger "$USER"
```

如果服务无法启动，先查看 `systemctl --user status` 和日志，重点检查 Node 路径、工作目录、端口和 `CODEX_COMMAND`，不要删除状态目录。

## 7. 输出访问信息

部署完成后报告以下信息：

1. 服务监听地址和端口。
2. 本机访问地址，例如 `http://127.0.0.1:8787`。
3. 局域网地址（仅在用户明确启用了局域网监听时），可用 `hostname -I` 获取。
4. 登录密码由用户在第 4 步自行设置，不在输出中显示。
5. systemd 服务状态、健康接口结果和测试结果。

提醒用户：局域网 HTTP 不加密，公网使用必须经过 Tailscale/VPN 或 HTTPS 反向代理；手机访问不了时先检查防火墙、网卡地址和网络隔离。

## 8. 升级和维护

升级 Codex CLI 后，协议生成产物需要与本机版本匹配：

```bash
codex --version
npm run codex:schema
npm run build
```

确认没有重要活动 Turn 后再重启服务：

```bash
systemctl --user restart codex-console.service
```

若升级后出现协议未知事件或模型列表错误，保留日志中的方法名和 Codex 版本，阅读 `docs/TECHNICAL_DESIGN.md` 的协议适配章节；不要把完整提示词、文件内容或认证信息粘贴到公开 issue。

## 必须向用户确认的情况

遇到以下情况，Codex 不得自行做出扩大权限或中断工作的决定：

- Codex CLI 未安装或未登录；
- 需要用户提供、修改或迁移密码/Token；
- 端口已被其他进程占用；
- 当前存在重要或不明确的活动 Turn；
- 需要开放防火墙、绑定公网地址、配置域名或申请 TLS 证书；
- 需要更改 `CODEX_WORKSPACE_ROOT` 到用户目录之外；
- 需要删除状态、上传文件、日志或其他用户数据。
