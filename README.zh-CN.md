# Codex WebApp

[English README](README.md)

一个开源、自托管的 Codex Web 控制台。Codex 持续运行在本机，你可以使用手机或桌面浏览器查看对话、发送指令和处理中断。

> 本项目是非官方项目，与 OpenAI 没有任何隶属、授权或背书关系。

<img width="2552" height="1340" alt="image" src="https://github.com/user-attachments/assets/f2338052-777d-4c06-8cbb-3f2facec86b8" />
<img width="2547" height="1337" alt="image" src="https://github.com/user-attachments/assets/c883a2ae-3772-4401-97b7-086e381d8b80" />


## 项目用途

Codex WebApp 在本机运行 daemon，由 daemon 通过 stdio 启动并管理官方 `codex app-server`。浏览器通过经过认证的 HTTP 和 WebSocket 连接 daemon，不需要云端中转服务。

```text
手机 / 桌面浏览器
          |
          | HTTP + WebSocket
          v
codex-console daemon
          |
          | stdin/stdout JSONL
          v
官方 codex app-server -> 本机项目和工具
```

## 功能

- 适配手机、平板和桌面浏览器的 Codex 风格响应式对话界面。
- 密码登录、Argon2id 密码哈希和 HttpOnly 会话 Cookie。
- 创建、恢复、分支、归档线程，并切换本机项目目录。
- 实时显示 Turn 状态、审批请求、用户输入请求和其他 Codex 窗口的活动。
- 中止正在运行的 Turn，在执行期间发送后续指令，并按线程排队等待执行。
- 编辑最近一条用户消息并重新发送。
- 区分用户消息、执行过程消息和最终回复，执行过程可以整体收纳或展开。
- 支持 Markdown/GFM 和 LaTeX/KaTeX 渲染。
- 自动发现 Codex 模型，并可持久添加本机第三方 Provider 支持的自定义模型名。
- 支持按线程切换模型、图片/文件/音频附件，以及桌面端剪贴板粘贴图片和文件。
- 支持受认证保护的工作区浏览、上传文件到当前目录、带行号的文本预览、媒体/PDF 预览、文件链接和复制服务器绝对路径。
- 桌面端左右侧栏可以独立收起，并可在当前线程目录运行受限的只读命令。
- 支持深色/浅色主题和可安装的 PWA。

## 使用 Codex 配置

推荐的配置方式是把本仓库交给你自己的 Codex，让它先检查当前机器环境，再执行安装。把仓库地址和下面的 Prompt 发给它，并要求它遵守仓库中的文档：

```text
请在这台机器上配置 Codex WebApp。

仓库地址：https://github.com/bianyh/Codex-WebApp

先阅读 AGENTS.md、README.md、docs/CODEX_SETUP.md 和
docs/TECHNICAL_DESIGN.md。然后检查本机 Node.js 和 Codex CLI，确认
Codex 已登录，安装依赖、构建项目、运行测试，请我设置登录密码，并
根据我选择的工作区配置 daemon。在 Linux 上，只有检查现有服务和活动
Codex Turn 后，才安装用户级 systemd 服务。

不要输出或提交密码、Token、Cookie、API key、私钥、上传文件或机器
相关的敏感信息。没有先询问我，不要重启服务或中断重要的活动 Turn。
最后报告本机/局域网访问地址、服务状态、健康检查结果和验证命令。
```

给 Codex 的执行规则见 [AGENTS.md](AGENTS.md)，自动配置的详细步骤见 [docs/CODEX_SETUP.md](docs/CODEX_SETUP.md)。

## 面向人类的文档

手动安装、环境变量、systemd 部署、安全建议、升级和故障排查请阅读 [README4HUMAN.md](README4HUMAN.md)。

架构和协议设计见 [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md)。

## 许可证

本仓库目前没有附带开源许可证。在项目所有者补充许可证之前，代码仍受适用版权法下的默认权利保护。
