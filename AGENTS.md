# Codex WebApp 仓库指令

本文件是仓库级持久指令。任何在本仓库中工作的 Codex 都必须先阅读：

1. `README.md`
2. `docs/CODEX_SETUP.md`
3. `docs/TECHNICAL_DESIGN.md`

## 项目边界

- 目标是让官方 Codex CLI/app-server 在本机运行，并通过本机 daemon 的 HTTP/WebSocket 接口供手机和桌面浏览器使用。
- 不把对话、文件或凭据发送到云端中转服务，不新增第三方 Relay。
- 浏览器不能直接连接或控制 `codex app-server`；app-server 只通过 daemon 的本机 stdio 连接。
- 保留现有的单密码登录、线程操作、运行状态识别、中止、排队指令、审批、文件预览、Markdown/LaTeX、上传和主题功能。

## 配置和安全规则

- 不硬编码密码、Token、Cookie、SSH 密钥、代理凭据或用户机器的敏感路径。
- 不提交 `.env`、`state.json`、`apps/daemon/data`、上传附件、日志、构建产物和本机生成的 Codex 协议状态。
- 不直接暴露 `codex app-server` 端口；需要手机访问时，优先使用 Tailscale/VPN 或 HTTPS 反向代理。
- `CODEX_WORKSPACE_ROOT` 是文件浏览和新建目录的安全边界，任何路径处理都必须继续使用现有的规范化和越界检查。
- 修改或重启 systemd 服务前，先检查当前服务状态和活动 Turn。活动 Turn 可能因 daemon/app-server 重启而中断；存在重要任务时必须等待空闲或让用户明确确认。
- 不启用会隔离 `/proc/<pid>/fd` 的 `PrivateTmp` 或 `ProtectSystem`，否则外部 Codex Turn 识别会失效。

## 开发规则

- 修改前阅读相关模块和测试，保持现有 TypeScript、React、Fastify、WebSocket 和 CSS 约定。
- 优先使用现有领域类型、协议适配和鉴权辅助函数，不重复实现平行抽象。
- 不使用破坏性的 Git 命令，不覆盖用户未要求修改的文件，不把父目录 Git 仓库的文件加入本项目。
- 每次行为修改后至少运行 `npm run build` 和 `npm test`；涉及依赖时再运行 `npm audit --omit=dev`。
- `codex app-server` 是实验性协议。升级 Codex CLI 后运行 `npm run codex:schema`，检查生成结果并更新兼容代码和测试。

## 自动配置步骤

当用户要求配置或部署本项目时，按 `docs/CODEX_SETUP.md` 执行：

1. 检查 Node.js、npm、Codex CLI 和 Codex 登录状态，不打印敏感内容。
2. 检查是否已有 `codex-console.service` 或活动 Turn。
3. 安装依赖、构建并运行测试。
4. 让用户设置至少 12 个字符的登录密码；不要猜测或在输出中回显密码。
5. 根据用户选择设置 `CODEX_CWD`、`CODEX_WORKSPACE_ROOT`、监听地址和端口。
6. 为 Linux 安装用户级 systemd 服务；将机器路径写入仓库之外的 `~/.config/codex-console/environment`，不要修改模板后提交个人绝对路径。
7. 启动后检查 `/api/healthz`、服务日志和手机可访问地址。
8. 最终只报告路径、地址、服务状态和验证结果，不报告密码、Cookie、Token 或 Codex 凭据。

遇到 Codex 未安装或未登录、端口被占用、需要打开防火墙、需要公网域名/HTTPS、当前有重要活动 Turn，或需要用户提供凭据时，先向用户说明并请求确认，不要擅自扩大部署范围。
