# 本机 Codex 移动控制台技术设计

## 1. 文档目的

本文档定义一个供个人使用的、自托管的 Codex 移动控制台。Codex 和控制台服务都运行在同一台开发机或服务器上，手机通过浏览器/PWA 访问服务，查看类似 Codex App 的会话界面并继续操作任务。

本文档是后续实现的基线，优先保证：

1. Codex 进程和项目文件始终留在本机。
2. 通过官方 `codex app-server` 的结构化协议通信，不抓取桌面画面、不解析终端 ANSI 文本。
3. 单用户、单密码登录；不引入账号系统、第三方 Relay 或云端数据同步。
4. 手机端拥有完整的信息层次和操作闭环，而不是简单的聊天页面或远程终端。
5. Codex 升级后可以通过协议版本探测和适配层演进，而不是大面积重写 UI。

OpenAI Docs 在当前网络环境下无法直接抓取正文，官方页面可能返回访问拦截页。因此，实际协议以运行时安装的 Codex 版本通过 `generate-ts`/`generate-json-schema` 生成的产物为准；升级时再用 [OpenAI Docs - Codex](https://developers.openai.com/codex) 核对语义和兼容性。本文不把实验性协议字段当作跨版本稳定 API。

当前开发机实测版本是 `codex-cli 0.115.0`。`codex app-server` 及协议仍属于 experimental，必须在项目中固定版本、记录能力集并维护兼容测试。

## 2. 目标和非目标

### 2.1 第一阶段目标

- 在本机启动 Web 服务和 `codex app-server` 子进程。
- 浏览器使用密码登录后，建立一个受认证的 HTTP + WebSocket 会话。
- 查看线程列表、线程历史和当前状态。
- 创建线程、恢复线程、发送新 Turn、运行中追加指令、打断 Turn。
- 实时展示 Agent 消息、Reasoning 摘要、Plan、命令执行、文件修改、Diff、MCP 调用和错误。
- 在手机上处理 Codex 的命令审批、文件修改审批和用户问题。
- 发现 app-server 模型列表，并允许保存额外模型标识供本机已配置的第三方 Provider 使用。
- 桌面左右侧栏独立折叠，在当前线程目录执行无 shell 的只读诊断命令。
- 页面刷新或网络短暂断开后恢复当前线程和未显示事件。
- 使用 PWA 安装到手机主屏幕，适配 iOS Safari 和 Android Chrome。

### 2.2 后续目标

- 本机文件树、文件预览和 Git diff。
- 图片附件、生成图片和文件下载。
- 多项目配置和项目级默认模型/沙箱/审批策略。
- 浏览器推送通知和任务完成提醒。
- 多主机支持（每台主机运行一个本地控制台实例）。
- Capacitor 包装为原生 App，但复用同一套 Web UI 和协议层。

### 2.3 明确非目标

- 不实现模型调用、Codex Agent runtime 或 Responses API 代理。
- 不把聊天内容同步到第三方服务器。
- 不实现多租户、团队账号、角色权限和公共注册。
- 不直接暴露 `codex app-server` 的公网 WebSocket。
- 不通过截图、Chrome DevTools Protocol 或 tmux 屏幕抓取仿制 Codex UI。
- 不提供任意 shell、PTY 或交互终端。直接命令只经过独立的只读白名单执行器；Codex 产生的其他命令仍按 app-server 审批协议处理。

## 3. 总体架构

```text
┌──────────────────────────────┐
│ 手机 / 桌面浏览器              │
│ React + PWA                   │
└──────────────┬───────────────┘
               │ HTTPS + WebSocket
               │ 密码登录后的 HttpOnly Session Cookie
┌──────────────▼───────────────┐
│ codex-console daemon          │
│                              │
│ HTTP API / WebSocket Gateway │
│ Auth + Session               │
│ Project Policy               │
│ Codex Adapter                │
│ Event Store / Replay Buffer  │
│ Process Supervisor           │
└──────────────┬───────────────┘
               │ stdin/stdout JSONL
┌──────────────▼───────────────┐
│ codex app-server              │
│ codex app-server --listen    │
│ stdio://                      │
└──────────────┬───────────────┘
               │
               ▼
       项目目录 / Git / Shell
```

### 3.1 进程边界

Daemon 是唯一允许接触浏览器的进程，也是唯一直接启动和管理 `codex app-server` 的进程。前端不能直接打开 app-server 的 stdio、Unix socket 或 WebSocket。

第一版默认每个 Daemon 管理一个 app-server 进程。它可以服务多个线程，但所有线程共享同一个 Codex 登录环境和 `CODEX_HOME`。若以后需要不同账号或不同 `CODEX_HOME`，再扩展为 `Profile -> AppServerProcess` 映射，不在第一版引入。

### 3.2 监听地址

- 默认监听 `127.0.0.1:8787`，避免启动后意外暴露到局域网。
- 需要手机访问时显式设置 `CODEX_CONSOLE_HOST=0.0.0.0`，并通过局域网、Tailscale 或反向代理提供入口。
- app-server 只使用 `stdio://`，不启用官方 experimental 的公网 WebSocket 监听。
- 生产部署应使用 HTTPS。若暂时使用局域网 HTTP，必须在启动日志和设置页明确显示“密码会以明文传输”的风险。

## 4. 推荐仓库结构

```text
codex-console/
├── apps/
│   ├── web/                         # React + Vite + PWA
│   └── daemon/                      # Fastify HTTP/WS 服务、进程管理
├── packages/
│   ├── domain/                      # 与 Codex 版本无关的稳定领域模型
│   ├── codex-adapter/               # JSON-RPC、Schema、版本能力适配
│   ├── protocol/                    # 浏览器 <-> daemon 的 DTO 与 Zod schema
│   ├── ui/                          # 时间线、消息块、审批卡片、Diff 等共享组件
│   └── config/                      # 配置读取、默认值、路径策略
├── generated/
│   └── codex/                       # 当前 Codex 生成的 TS 类型和 JSON Schema
├── scripts/
│   ├── generate-codex-schema.mjs
│   └── install-service.sh
├── docs/
│   └── TECHNICAL_DESIGN.md
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

建议使用 `pnpm` workspace。所有包使用 TypeScript strict 模式；前端和 daemon 共享 DTO，但前端不直接 import `generated/codex`，只能依赖 `domain` 和 `protocol`。

## 5. Codex app-server 适配层

### 5.1 启动和握手

Daemon 启动：

```bash
codex app-server --listen stdio://
```

进程管理器必须：

- 使用 `child_process.spawn`，分别持有 stdin/stdout/stderr；
- 以换行分隔 JSON 为读取单位，不用整块 stdout 解析；
- 只把 stdout 当作 JSON-RPC 通道，stderr 进入脱敏日志；
- 为每个请求维护 `id -> Promise` 关联表；
- 限制单行最大字节数，超限时终止异常进程；
- 进程退出时拒绝全部未完成请求，并向浏览器发送 `server/unavailable`；
- 使用指数退避重启，连续失败达到阈值后停止自动重启并显示可操作错误。

每个 app-server 连接只执行一次：

```text
initialize -> initialized notification
```

`initialize.params.clientInfo` 应填入稳定的客户端名称和版本，例如：

```json
{
  "clientInfo": {
    "name": "codex_console",
    "title": "Codex Console",
    "version": "0.1.0"
  }
}
```

### 5.2 版本和 Schema

安装或升级 Codex 后运行：

```bash
codex --version
codex app-server generate-ts --out generated/codex
codex app-server generate-json-schema --out generated/codex-schema
```

在构建产物中记录：

```json
{
  "codexVersion": "0.115.0",
  "generatedAt": "2026-08-31T00:00:00Z",
  "protocolGeneration": "v1-or-v2"
}
```

适配层应该将原始协议映射为稳定接口：

```ts
interface CodexAdapter {
  initialize(): Promise<AdapterCapabilities>;
  listThreads(input: ListThreadsInput): Promise<ThreadSummary[]>;
  readThread(threadId: string): Promise<ThreadSnapshot>;
  startThread(input: StartThreadInput): Promise<ThreadSnapshot>;
  resumeThread(input: ResumeThreadInput): Promise<ThreadSnapshot>;
  startTurn(threadId: string, input: UserInput[]): Promise<TurnSummary>;
  steerTurn(threadId: string, input: UserInput[]): Promise<void>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  respondToServerRequest(
    requestId: string,
    response: ServerRequestResponse,
  ): Promise<void>;
}
```

未知通知必须保留为 `unknown` 事件并记录协议方法名，不得因为一个新事件让整个连接崩溃。未知的服务端请求默认拒绝，并在 UI 显示“当前版本不支持此请求”。

### 5.3 第一版使用的方法和事件

当前生成的协议至少包含以下能力，具体字段必须以生成产物为准：

| 类别 | 方法/事件 | UI 用途 |
|---|---|---|
| 初始化 | `initialize`、`initialized` | 建立能力集和版本信息 |
| 线程 | `thread/list`、`thread/read`、`thread/start`、`thread/resume`、`thread/fork` | 会话列表、打开、创建、分支 |
| Turn | `turn/start`、`turn/steer`、`turn/interrupt` | 发送、追加指令、中断 |
| 主状态 | `thread/status/changed`、`turn/started`、`turn/completed` | 顶部状态、按钮状态、完成时间 |
| 文本 | `item/agentMessage/delta`、`item/completed` | 流式 Agent 消息 |
| 推理 | `item/reasoning/summaryTextDelta`、`summaryPartAdded` | 可折叠的思考摘要 |
| 工具 | `item/started`、命令输出 delta、MCP progress | 命令卡片、工具进度、耗时 |
| 文件 | 文件变更事件、`turn/diff/updated` | 修改文件列表、Diff 面板 |
| 计划 | `item/plan/delta`、`turn/plan/updated` | Plan 卡片和步骤进度 |
| 资源 | `thread/tokenUsage/updated`、模型列表 | 用量栏、模型选择器 |
| 服务端请求 | 命令审批、文件审批、`item/tool/requestUserInput`、MCP elicitation | 手机审批卡片和表单 |
| 错误 | `error`、`configWarning`、`deprecationNotice` | 可定位的错误提示 |

## 6. Daemon 内部模块

```text
HTTP Server
├── authController
├── healthController
└── websocketController

Application Services
├── ThreadService
├── TurnService
├── ApprovalService
├── ProjectService
└── ReplayService

Infrastructure
├── CodexProcessManager
├── JsonRpcTransport
├── EventBus
├── SessionStore
├── ConfigStore
└── Logger
```

### 6.1 EventBus

所有 app-server 通知先进入 Daemon 的事件归一化器，再发布给浏览器：

```ts
type ConsoleEvent = {
  eventId: string;       // 单调递增或 ULID
  threadId?: string;
  receivedAt: string;
  sourceMethod: string;
  payload: DomainEvent;
};
```

EventBus 保存有限大小的内存环形缓冲区，例如最近 2,000 个事件或 10 分钟，以便断线重放。事件不默认永久保存 Prompt 或完整输出，避免把敏感代码和凭据写进数据库。

### 6.2 会话状态

每个浏览器连接维护：

```text
authenticated
  -> subscribing(threadId)
  -> live(lastEventId)
  -> reconnecting
  -> resyncing(thread/read)
  -> live
```

重连时浏览器发送 `lastEventId`。若环形缓冲区仍覆盖该 ID，Daemon 只补发缺失事件；否则先执行 `thread/read`，发送完整 `thread/snapshot`，再切换到实时事件。前端 reducer 必须按 `eventId` 去重。

### 6.3 并发和请求路由

- 同一线程只允许一个活动 Turn；按钮在请求发送后立即进入 pending，防止重复点击。
- `turn/steer` 只允许发送到正在运行且状态支持 steering 的 Turn。
- 一个服务端审批请求只能被响应一次；重复响应返回幂等成功或明确的 `already_resolved`。
- 多个浏览器标签页可以观察同一线程，但第一版只允许一个控制连接写入，以避免手机和桌面同时发送造成竞态。观察连接仍可只读。

## 7. 密码登录和安全模型

用户要求只使用登录密码控制访问。这里的“只需要密码”表示不引入账号、OAuth、设备配对或第三方身份服务；仍然需要正确的会话、传输和浏览器安全措施。

### 7.1 初始化密码

首次启动如果没有密码哈希，Daemon 必须拒绝提供业务页面，只提供本机初始化命令：

```bash
codex-console password set
codex-console password change
```

密码规则：最少 12 个字符；不强制复杂字符，避免用户使用弱密码时产生错误安全感；CLI 通过隐藏输入读取。配置文件只保存 Argon2id 哈希和参数，不保存明文密码。

推荐参数：Argon2id、内存 64 MiB、迭代 3、并行度 1（实际参数应根据本机基准调整）。登录失败采用恒定时间比较，并对 IP/会话进行速率限制，例如 5 次/分钟，超过后逐步延迟。

### 7.2 HTTP 会话

- `POST /api/auth/login`：提交密码，成功后设置随机 256-bit HttpOnly、SameSite=Strict、Secure（HTTPS 时）Cookie。
- Daemon 只保存会话 token 的哈希、创建时间、最后访问时间和过期时间；进程重启后默认使旧会话失效。
- `POST /api/auth/logout`：撤销当前会话。
- `GET /api/auth/me`：返回登录状态和服务能力，不返回任何凭据。
- 默认会话有效期 7 天，滑动续期；可在配置中缩短。
- 登录响应不区分“用户不存在”和“密码错误”（本项目没有用户名），错误信息统一为“密码错误”。

### 7.3 WebSocket 认证

浏览器 WebSocket 使用同源 Cookie 完成认证，服务端必须：

1. 校验 Cookie 会话。
2. 校验 `Origin` 等于配置的 Web Origin；缺失或不匹配直接拒绝。
3. 限制单连接消息大小和消息频率。
4. 在连接建立后发送 `server/ready`，包含 Codex 版本和能力集。

不要把 session token 放在 URL query string，避免出现在访问日志、代理日志和浏览器历史中。

### 7.4 传输和暴露策略

- 默认 loopback；用户主动开放局域网时才监听 `0.0.0.0`。
- 生产环境使用 Caddy/Nginx 提供 HTTPS，或使用 Tailscale HTTPS；这不增加新的应用层登录方式，只保护传输。
- 永远不将 `codex app-server --listen ws://...` 直接暴露公网。
- 服务端健康检查 `/healthz` 不泄露项目路径、Codex token 或环境变量。
- 日志禁止写入登录密码、Cookie、Prompt 全文、环境变量、SSH 私钥和认证 token。

### 7.5 本机权限

- 使用普通 OS 用户运行 Daemon 和 Codex，禁止 root。
- 项目目录使用显式白名单；所有路径先 `realpath`，拒绝白名单外路径和符号链接逃逸。
- 默认 Codex 沙箱为 `workspace-write`，默认审批策略为 `on-request`。
- UI 的直接命令接口不启动 shell，只允许 `pwd`、`ls` 和只读 Git 子命令；限制工作目录、路径、参数、运行时间、输出量和并发数。它不替代 Codex 命令审批，也不扩展为 PTY。

## 8. 浏览器协议

浏览器协议与 app-server 协议隔离。浏览器永远不传递任意 JSON-RPC 方法名，而是调用受限的业务动作。

### 8.1 HTTP API

```text
GET  /api/healthz
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me

GET    /api/models
POST   /api/models/custom
DELETE /api/models/custom

GET  /api/projects
POST /api/projects
PATCH /api/projects/:projectId

GET  /api/fs/list?path=
POST /api/fs/upload?path=&name=&mime=
POST /api/fs/directories
GET  /api/fs/content?path=
GET  /api/fs/raw?path=
POST /api/commands

GET  /api/threads?projectId=&cursor=
GET  /api/threads/:threadId
POST /api/threads
POST /api/threads/:threadId/resume
POST /api/threads/:threadId/fork
POST /api/threads/:threadId/archive
```

所有接口返回统一结构：

```ts
type ApiResponse<T> =
  | { ok: true; data: T; requestId: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean }; requestId: string };
```

### 8.2 WebSocket 客户端动作

```ts
type ClientAction =
  | { type: "subscribe_thread"; threadId: string; lastEventId?: string }
  | { type: "start_turn"; threadId: string; input: UserInput[]; settings?: TurnSettings }
  | { type: "steer_turn"; threadId: string; input: UserInput[] }
  | { type: "interrupt_turn"; threadId: string; turnId: string }
  | { type: "respond_request"; requestId: string; response: ServerRequestResponse };
```

服务端推送：

```ts
type ServerEvent =
  | { type: "thread_snapshot"; eventId: string; snapshot: ThreadSnapshot }
  | { type: "thread_event"; eventId: string; threadId: string; event: DomainEvent }
  | { type: "server_request"; eventId: string; request: PendingServerRequest }
  | { type: "server_ready"; codexVersion: string; capabilities: AdapterCapabilities }
  | { type: "server_unavailable"; reason: string; retryAt?: string }
  | { type: "error"; error: ConsoleError };
```

## 9. UI/UX 设计：接近 Codex App 的信息结构

目标是复用 Codex App 的工作流、信息层次和交互语义，而不是承诺复制桌面端像素。官方 App 的私有视觉细节不作为本项目的 API 依赖。页面必须优先支持“选线程 -> 看进度 -> 处理请求 -> 继续指令 -> 检查结果”。

### 9.1 桌面布局

```text
┌──────────────┬──────────────────────────────────────┬─────────────────┐
│ 线程/项目栏   │ 当前线程时间线                         │ 上下文/检查栏     │
│              │                                      │                 │
│ 搜索          │ 顶部：标题、状态、模型、用量、更多操作 │ Plan / Command   │
│ 项目切换      │                                      │ Changed files   │
│ 最近线程      │ 用户消息                             │ Diff            │
│ 归档线程      │ Agent 消息                            │ Files           │
│              │ Reasoning / Plan / Tool 卡片          │ Usage           │
│              │ 审批卡片                              │                 │
│              │ 底部固定 Composer                      │                 │
└──────────────┴──────────────────────────────────────┴─────────────────┘
```

- 左栏宽度 280-320px，可折叠；线程项显示标题、最近更新时间、运行状态点和未读标记。
- 中栏是唯一主阅读流，消息按 Turn 分组；用户输入、Agent 文本、Reasoning、命令、文件修改和审批保持时间顺序。
- 左右栏均可独立折叠并在本机浏览器中记住状态；右栏以 Tab 显示 Plan、Changed files、Diff、Files、受限命令和 Usage。
- 顶部状态栏显示当前模型、推理强度、沙箱/审批模式、Token 用量和运行耗时。
- Composer 固定在中栏底部，支持多行输入、图片附件入口、发送/停止按钮和“追加到当前 Turn”状态。

### 9.2 手机布局

手机端不把三栏硬缩到不可用，而是采用单主列 + 抽屉/底部 Sheet：

```text
┌──────────────────────┐
│ ☰ 线程标题     ⋯     │  顶部 App Bar
├──────────────────────┤
│ 状态/模型/用量        │  可横向滚动但不换行溢出
├──────────────────────┤
│                      │
│     时间线            │  主内容
│                      │
├──────────────────────┤
│ Plan Diff Files ...   │  横向滚动上下文 Tab
├──────────────────────┤
│ Composer              │  多行输入 + 发送/停止
└──────────────────────┘
```

- 左上角菜单打开项目/线程抽屉；抽屉中支持搜索、最近、运行中、归档筛选。
- Plan、Diff、Files、Usage 通过底部 Sheet 打开，不离开当前线程；Sheet 可下拉关闭。
- 审批和用户问题使用全宽、固定底部的高优先级卡片；按钮至少 44px 触控尺寸，危险动作使用明确的红色语义。
- 长命令、Diff 和 Reasoning 默认折叠，点击后展开；文本不得横向溢出，代码使用横向滚动容器。
- 流式回答期间保留滚动位置：用户向上阅读历史时不强制跳到底部；回到底部后才自动跟随新事件。
- 页面刷新后优先恢复上一次打开的线程和面板，不弹出营销或说明页。

### 9.3 视觉系统

- 使用中性深浅双色主题，强调色只用于状态和操作，不让界面成为单一色调。
- 8px 以下圆角，避免层层嵌套卡片；页面区域使用无框布局，卡片只用于重复的消息块、审批、Diff 文件项和模态内容。
- 使用 Lucide 图标表示发送、停止、展开、复制、回到末尾、搜索、设置等操作；图标按钮提供 tooltip/无障碍名称。
- 所有固定格式元素设置稳定尺寸：顶部栏、Composer、图标按钮、状态徽标和代码块不能因流式文字改变布局。
- 颜色不能作为唯一状态信号；运行、等待、成功、失败必须同时使用文字或图标。
- 必须支持键盘导航、屏幕阅读器标签、焦点可见和减少动画偏好。

### 9.4 核心组件

```text
AppShell
├── ProjectThreadDrawer
├── ThreadHeader
│   ├── ThreadStatus
│   ├── ModelBadge
│   └── ThreadActions
├── ConversationTimeline
│   ├── UserMessageBlock
│   ├── AgentMessageBlock
│   ├── ReasoningBlock
│   ├── PlanBlock
│   ├── CommandExecutionBlock
│   ├── FileChangeBlock
│   ├── McpToolBlock
│   └── ApprovalRequestCard
├── ContextPanel / MobileContextSheet
│   ├── PlanPanel
│   ├── ChangedFilesPanel
│   ├── DiffPanel
│   ├── FilePreviewPanel
│   └── UsagePanel
└── Composer
```

## 10. 前端状态模型

前端使用事件 reducer，不在组件中直接拼接字符串：

```ts
type ThreadStore = {
  connection: "offline" | "connecting" | "live" | "resyncing";
  selectedThreadId: string | null;
  threads: Record<string, ThreadSummary>;
  snapshots: Record<string, ThreadSnapshot>;
  pendingRequests: Record<string, PendingServerRequest>;
  lastEventId: string | null;
  composer: ComposerState;
};
```

Reducer 规则：

- `item/agentMessage/delta` 追加到对应 Item 的 buffer；收到 `item/completed` 后冻结该 Item。
- Turn/Thread 状态只能由带版本或有序事件推进，过期事件丢弃。
- 网络重连期间 Composer 可离线排队，但第一版只允许排队一条文本指令，并在发送前明确显示“待发送”。
- 服务器请求 pending 时禁止因页面重渲染丢失；刷新后通过 `thread/read` 重新发现仍未解决的请求。
- 所有服务端错误映射为稳定的本地化错误码，原始 JSON 仅在开发诊断面板可见。

## 11. 数据持久化

第一版只持久化控制面数据，建议 SQLite：

```text
settings
  key, value_json, updated_at

auth_sessions
  token_hash, created_at, last_seen_at, expires_at, revoked_at

projects
  id, name, canonical_path, enabled, default_settings_json, created_at, updated_at

ui_preferences
  key, value_json, updated_at
```

不复制完整 Codex Transcript。线程历史由 app-server 提供；仅在内存中保留有限事件环形缓冲区。若未来需要离线搜索，再以明确的“本地缓存开启”设置加入加密数据库，并提供清空功能。

SQLite 文件权限设为 `0600`，默认位置：

```text
Linux: $XDG_STATE_HOME/codex-console/state.db
macOS: ~/Library/Application Support/Codex Console/state.db
Windows: %LOCALAPPDATA%/Codex Console/state.db
```

## 12. 部署和运行

### 12.1 开发模式

```bash
pnpm install
pnpm codex:schema
pnpm dev
```

开发模式启动 Vite 和 Daemon，Vite 仅用于前端热更新；真正的 WebSocket 仍由 Daemon 提供。

### 12.2 生产模式

```bash
pnpm build
codex-console password set
codex-console start
```

Linux 使用 systemd：

```ini
[Unit]
Description=Codex Console
After=network.target

[Service]
Type=simple
User=%i
ExecStart=/usr/local/bin/codex-console start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=%h/.codex %h/.local/share/codex-console

[Install]
WantedBy=default.target
```

`ReadWritePaths` 必须按实际项目目录调整；systemd 防护选项不能替代项目白名单。

### 12.3 手机访问

开发阶段：

1. Daemon 显式绑定局域网地址。
2. 手机和本机处于同一网络。
3. 浏览器访问 `http://<本机局域网地址>:8787`。

长期使用：通过 Tailscale 或 Caddy 提供 HTTPS。应用层仍只使用一个密码，不引入额外登录服务。

## 13. 可观测性和故障处理

### 13.1 健康状态

`/api/healthz` 返回：

```json
{
  "ok": true,
  "daemonVersion": "0.1.0",
  "codexVersion": "0.115.0",
  "appServer": "ready",
  "activeThreads": 2,
  "uptimeSeconds": 1234
}
```

不返回路径、环境变量、账号信息或 token。

### 13.2 状态分类

前端必须区分：

- `connecting`：尚未完成 WebSocket 握手；
- `offline`：网络断开，可重连；
- `codex_starting`：Daemon 正在拉起 app-server；
- `codex_unavailable`：进程退出或握手失败；
- `thread_loading`：正在读取线程历史；
- `turn_running`：Turn 运行中；
- `waiting_approval`：等待用户审批；
- `waiting_input`：等待用户问题回答；
- `completed`、`failed`、`interrupted`：Turn 终态。

错误界面必须给出恢复动作：重试连接、重启 app-server、重新读取线程、复制诊断 ID。

## 14. 测试策略

### 14.1 单元测试

- JSONL 分帧、JSON-RPC 请求响应关联和异常进程退出。
- 协议事件到领域事件的映射。
- EventBus 环形缓冲和重放边界。
- reducer 对重复、乱序和重连事件的处理。
- 项目路径白名单和符号链接逃逸检查。
- Argon2id 密码校验、会话撤销、过期和速率限制。

### 14.2 集成测试

- 用真实 `codex app-server` 完成 initialize、thread/start、turn/start 和 turn/completed。
- 模拟命令审批、文件修改审批和用户问题，验证手机端响应能正确回写 JSON-RPC。
- app-server 被杀死后，Daemon 状态和浏览器提示正确转换，并验证自动重启退避。
- 浏览器断线、刷新和补发事件，不产生重复消息或重复 Turn。

### 14.3 Playwright E2E

至少覆盖 390x844（手机）、768x1024（平板）和 1440x900（桌面）：

1. 登录、错误密码、登出和过期会话。
2. 手机打开线程抽屉、选择线程、发送消息。
3. 流式 Agent 消息、Reasoning、命令、文件修改和 Plan 渲染。
4. 审批卡片在手机底部不遮挡 Composer，点击后状态更新。
5. 横向 Diff、长命令和长文件名不造成页面溢出。
6. 切换 Plan/Diff/Files/Usage Sheet 后返回时间线，滚动位置合理。
7. WebSocket 断开后自动重连和状态补齐。

### 14.4 协议兼容矩阵

每次 Codex 升级至少跑一遍真实协议冒烟测试，并记录：

```text
Codex version | schema generation | initialize | thread | turn | approvals | diff | result
```

发现方法或字段变化时，先在 `codex-adapter` 添加兼容分支，再更新 UI，不允许前端直接读取未经适配的新字段。

## 15. 分阶段交付

### Milestone 0：协议 Spike

- 建立 workspace 和 `codex-adapter`。
- 自动生成 TS/JSON Schema。
- 完成 app-server 启动、握手、线程读取和一个 Turn。
- 输出结构化调试日志。

验收：命令行脚本可以创建线程、发送 Prompt、打印完整事件序列。

### Milestone 1：Daemon MVP

- HTTP、密码登录、Session Cookie。
- WebSocket 鉴权和事件广播。
- 项目白名单、线程列表、线程读取、发送/中断 Turn。
- systemd/本机启动脚本。

验收：同一局域网浏览器可登录并完成一次 Codex 任务。

### Milestone 2：Codex 风格 Web UI

- 三栏桌面布局、手机抽屉和底部 Sheet。
- 时间线、流式 Agent 消息、命令、文件变更、Reasoning、Plan。
- Composer、运行状态、用量和错误状态。

验收：手机 390px 宽度下主要流程无需横向缩放或桌面模式。

### Milestone 3：审批和可靠性

- 命令/文件/用户问题请求卡片。
- EventBus replay、thread/read resync、幂等响应。
- app-server 崩溃恢复和诊断页。

验收：手机可以在 Codex 等待期间完成审批或回答问题，断网恢复后不丢消息。

### Milestone 4：文件和定制能力

- 文件树、Diff、图片附件、通知。
- 项目级配置和可插拔面板。
- 可选 Capacitor 打包。

## 16. 关键设计决策记录

### ADR-001：使用 app-server，不使用终端抓取

选择结构化 JSON-RPC，因为它直接表达线程、Turn、Item、审批和文件变更；终端抓取会依赖渲染文本，难以可靠处理流式事件、折叠内容和版本升级。

### ADR-002：PWA 优先

个人使用场景下，PWA 可以同时覆盖 iOS、Android 和桌面浏览器，并让 UI 快速迭代。原生能力不足时再用 Capacitor 包装，不维护两套 UI。

### ADR-003：单密码而非账号系统

只有一个使用者，不需要用户名、注册、OAuth 或第三方身份服务。密码仍通过 Argon2id、HttpOnly Cookie、Origin 校验和速率限制实现完整会话安全。

### ADR-004：本地状态优先，Codex 为事实源

控制台只持久化项目配置、UI 偏好和会话元数据；对话历史和运行状态从 app-server 恢复，减少敏感数据复制和状态分叉。

### ADR-005：前端协议隔离

浏览器动作使用白名单 DTO，Codex 协议只存在于适配层。这样可以在不改 UI 的情况下适配不同 Codex CLI 版本，并避免浏览器获得任意 RPC 能力。

## 17. 第一批实现任务清单

- [ ] 初始化 pnpm workspace、TypeScript strict、ESLint、Prettier、Vitest、Playwright。
- [ ] 实现 `scripts/generate-codex-schema.mjs`，记录 Codex 版本和生成时间。
- [ ] 实现 JSONL transport、JSON-RPC correlation、CodexProcessManager。
- [ ] 实现 `initialize`、`thread/list`、`thread/read`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`。
- [ ] 实现 EventBus、事件 ID、环形缓冲和 resync。
- [ ] 实现 Argon2id 密码初始化、登录、HttpOnly Session Cookie、登出。
- [ ] 实现项目白名单和 `realpath` 路径校验。
- [ ] 实现浏览器 WebSocket DTO、Origin 校验和请求频控。
- [ ] 实现桌面三栏/手机单列布局骨架。
- [ ] 实现消息、命令、文件、Plan、审批等时间线卡片。
- [ ] 为 390px、768px、1440px 视口建立 Playwright 基线截图和溢出检查。

## 18. 完成定义

第一版只有在以下条件全部满足时才算可用：

- Codex 和控制台均可作为本机服务长期运行，重启后能恢复。
- 未登录无法获取项目、线程或 WebSocket 数据。
- 手机可以完成“登录 -> 打开线程 -> 发送指令 -> 查看流式输出 -> 处理审批 -> 查看结果”的闭环。
- 断线重连不会重复消息、重复发送或丢失待处理审批。
- 默认不向公网暴露 app-server；日志和数据库不包含明文密码及 Codex token。
- 在手机、平板和桌面视口下没有横向溢出、遮挡或无法点击的主要控件。
- Codex 升级后，协议冒烟测试能够明确报告兼容或不兼容，而不是静默产生错误状态。
