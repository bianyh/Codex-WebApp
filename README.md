# Codex WebApp

一个自托管的 Codex 移动控制台：Codex 在本机运行，手机或桌面浏览器通过响应式 Web/PWA 界面查看对话、发送指令、处理中断和审批请求。

> This project is unofficial and is not affiliated with or endorsed by OpenAI.

项目不会把对话转发到云端中转服务。浏览器只连接本机的 `codex-console` daemon，daemon 再通过 stdio 启动并管理官方 `codex app-server`。

## 功能

- 类 Codex App 的线程列表、消息时间线和流式输出界面，适配手机、平板和桌面浏览器。
- 密码登录、Argon2id 密码哈希、HttpOnly 会话 Cookie。
- 创建、恢复、归档和分支线程，并在创建线程时新建工作目录。
- 运行中状态识别，可中止本控制台或同一用户下其他 Codex CLI/app-server 的活动 Turn。
- Turn 运行期间继续发送指令；指令会按线程排队，当前 Turn 完成后自动执行。
- 编辑最近一条用户消息并重新发送。
- 用户消息、执行过程、最终回复分层显示；执行过程可一键收纳/展开。
- Markdown/GFM 和 LaTeX/KaTeX 渲染，兼容 `$...$`、`$$...$$`、`\\(...\\)`、`\\[...\\]` 以及常见的方括号 LaTeX 块。
- 模型选择器、图片/音频/普通文件上传，以及桌面端 `Ctrl+V` 粘贴图片或文件。
- 文件树、文本行号预览、图片/音频/视频/PDF 预览和受认证保护的文件流。
- 深色/浅色主题、PWA 安装和 WebSocket 实时更新。

## 工作原理

```text
手机 / 桌面浏览器（React + PWA）
              │ HTTP + WebSocket，密码会话 Cookie
              ▼
codex-console daemon（本机 HTTP/API 网关）
              │ stdin/stdout JSONL
              ▼
官方 codex app-server
              │
              ▼
本机项目目录、Git 和 Codex 工具
```

daemon 是唯一对浏览器开放的进程；`codex app-server` 不监听公网端口。事件和线程状态在 daemon 内存中短暂保存，用于实时更新和断线恢复，不会默认把完整提示词永久写入数据库。

## 前置条件

- Linux 或 macOS（用户级 systemd 方案需要 Linux；其他系统可直接运行 Node 进程）。
- Node.js 20 或更高版本，npm 10 或更高版本。
- 已安装并登录官方 Codex CLI，且命令 `codex` 可以在当前用户下执行。
- Git。
- 手机和服务器在同一局域网，或通过 Tailscale、VPN、HTTPS 反向代理访问。

你可以把整个仓库交给自己的 Codex，并要求它先阅读 `AGENTS.md`、`docs/CODEX_SETUP.md` 和 `docs/TECHNICAL_DESIGN.md`，再根据当前机器环境完成依赖安装、构建、密码设置和后台服务配置。这是本项目推荐的自动配置方式；自动化代理遇到缺少登录凭据、端口冲突、防火墙或正在执行的重要 Turn 时，应先向你确认。

## 快速开始

在仓库根目录执行：

```bash
npm install
npm run build
npm run start -- password set
npm run start
```

设置密码时可以交互式输入，也可以把密码作为参数传给 `password set`。密码至少 12 个字符；不要把密码写入 shell 历史、`.env` 或 Git。

默认只监听本机：`http://127.0.0.1:8787`。需要让手机访问时，显式绑定局域网地址：

```bash
CODEX_CONSOLE_HOST=0.0.0.0 npm run start
```

然后在手机浏览器打开服务器的局域网地址，例如 `http://192.168.1.20:8787`。若服务端有多个网卡，可用 `hostname -I` 查看可用地址。

开发模式分开启动 Vite 和 daemon：

```bash
npm run dev
```

Vite 默认地址为 `http://127.0.0.1:5173`，API 和 WebSocket 会代理到 `8787`。

## 配置

所有配置通过环境变量提供。常用变量如下：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CODEX_CONSOLE_HOST` | `127.0.0.1` | HTTP 监听地址；手机访问通常设为 `0.0.0.0` |
| `CODEX_CONSOLE_PORT` | `8787` | HTTP/WebSocket 端口 |
| `CODEX_CONSOLE_ORIGIN` | 空 | 设置后只接受完全匹配的浏览器 Origin |
| `CODEX_CONSOLE_DATA_DIR` | `~/.local/state/codex-console` | 密码哈希、会话状态和上传附件目录 |
| `CODEX_CWD` | 启动 daemon 的目录 | 新线程和 Codex 默认工作目录 |
| `CODEX_WORKSPACE_ROOT` | `CODEX_CWD` 的父目录 | 文件浏览器和新建目录允许访问的根目录 |
| `CODEX_COMMAND` | `codex` | Codex 可执行文件路径；使用版本管理器时建议填写绝对路径 |
| `CODEX_CONSOLE_SESSION_DAYS` | `7` | 登录会话有效天数 |
| `LOG_LEVEL` | `info` | Fastify 日志级别 |

例如，将默认项目和可浏览范围限制到指定目录：

```bash
CODEX_CWD=/srv/projects/demo \
CODEX_WORKSPACE_ROOT=/srv/projects \
CODEX_CONSOLE_HOST=0.0.0.0 \
CODEX_CONSOLE_PORT=8787 \
npm run start
```

服务器文件浏览器默认允许访问 `CODEX_WORKSPACE_ROOT` 下的目录；文本预览上限为 5 MiB，单个上传附件上限为 25 MiB，最多同时附加 8 个文件。

## 后台运行（Linux）

仓库中的 `deploy/codex-console.service` 是不绑定具体机器的 systemd 用户服务模板。服务默认假设仓库位于 `~/Codex-WebApp`、Node 和 Codex 位于 `PATH`；其他情况请在仓库之外创建 `~/.config/codex-console/environment` 覆盖路径和监听配置，不要把本机绝对路径提交到 Git：

```bash
mkdir -p ~/.config/codex-console
${EDITOR:-vi} ~/.config/codex-console/environment
```

至少按实际环境设置 `CODEX_CONSOLE_REPO`、`CODEX_NODE`、`CODEX_CWD`、`CODEX_WORKSPACE_ROOT` 和 `CODEX_COMMAND`；手机访问时再设置 `CODEX_CONSOLE_HOST=0.0.0.0`。该文件包含运行配置，建议执行 `chmod 600 ~/.config/codex-console/environment`。

```bash
mkdir -p ~/.config/systemd/user
ln -sfn "$PWD/deploy/codex-console.service" \
  ~/.config/systemd/user/codex-console.service
systemctl --user daemon-reload
systemctl --user enable --now codex-console.service
```

常用命令：

```bash
systemctl --user status codex-console.service
journalctl --user -u codex-console.service -f
systemctl --user stop codex-console.service
systemctl --user restart codex-console.service
```

服务启用了 `Restart=always`，认证状态默认保存在 `~/.local/state/codex-console`。如果希望退出登录后服务仍运行，请为该用户启用 systemd linger：

```bash
loginctl enable-linger "$USER"
```

重启服务会终止该 daemon 持有的 app-server Turn。执行重启前，先等待重要任务完成，或在界面中中止当前 Turn。若存在外部 Codex CLI 正在执行的 Turn，也不要无条件重启；详见 [Codex 配置手册](docs/CODEX_SETUP.md)。

## 安全边界

- 不要把 `8787` 直接暴露到公网。优先使用 Tailscale/VPN，或在可信反向代理后启用 HTTPS。
- 局域网 HTTP 不加密，密码可能被同一网络中的攻击者窃听；生产环境应使用 HTTPS。
- 不要提交 `.env`、`state.json`、上传附件、Cookie、Token、SSH 密钥或任何 Codex 凭据。
- `CODEX_WORKSPACE_ROOT` 决定文件浏览和新目录创建边界，请设置为足够小的目录。
- daemon 不会替浏览器执行任意 shell；命令由 Codex app-server 产生，并按审批协议展示。
- 外部 Turn 识别会读取同一用户下 Codex 进程的 `/proc/<pid>/fd`。因此 systemd 服务不能启用会创建独立挂载命名空间的 `PrivateTmp` 或 `ProtectSystem`。

## 开发、测试和协议升级

```bash
npm run build
npm test
npm audit --omit=dev
```

`codex app-server` 属于实验性接口。升级 Codex CLI 后，用当前版本重新生成协议类型并重新构建：

```bash
npm run codex:schema
npm run build
```

生成文件默认位于 `generated/codex`，该目录被 `.gitignore` 忽略，因为它与本机 Codex 版本相关。具体协议边界和实现说明见 [技术设计](docs/TECHNICAL_DESIGN.md)。

## 故障排查

先检查 daemon 是否可用：

```bash
curl -sS http://127.0.0.1:8787/api/healthz
```

常见问题：

- **无法登录**：在服务所在机器重新执行 `npm run start -- password set`；确认命令使用的是与后台服务相同的 `CODEX_CONSOLE_DATA_DIR`。
- **模型列表为空或线程加载失败**：确认 `codex --version` 可执行、Codex CLI 已登录，并检查 `journalctl --user -u codex-console.service`。
- **手机无法连接**：确认服务绑定 `0.0.0.0` 或服务器局域网地址，检查防火墙和网络隔离，并从手机访问正确的端口。
- **外部窗口状态没有同步**：确认 daemon 与 Codex CLI 使用同一 Linux 用户；systemd 单元不要启用 `PrivateTmp` 或 `ProtectSystem`。
- **升级后协议错误**：执行 `npm run codex:schema` 后重新 `npm run build`，再阅读技术设计中的兼容性说明。

## 文档导航

- [给 Codex 的配置手册](docs/CODEX_SETUP.md)：另一个 Codex 配置本项目时必须执行的检查和部署步骤。
- [仓库级 Codex 指令](AGENTS.md)：自动化修改本仓库时必须遵守的规则。
- [技术设计](docs/TECHNICAL_DESIGN.md)：架构、协议适配、状态管理和安全边界。

## 许可证

本仓库当前未附带明确的开源许可证。除非仓库所有者另行补充许可证，否则请不要把代码用于超出版权法默认许可范围的再分发。
