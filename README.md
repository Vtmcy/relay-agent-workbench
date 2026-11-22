# Relay · 云端 Agent 工作台

Relay 把真实 Codex CLI 接进单用户浏览器工作台。新建会话后可以上传材料、发起任务、跟踪命令和文件变化、预览及下载成果。关闭页面时服务端继续执行，重新打开可恢复会话。后续消息沿用同一个 Codex 线程和工作目录。

## Docker 启动

需要运行 Linux 容器的 Docker Engine 或 Docker Desktop，以及 Docker Compose。将 `.env.example` 复制为 `.env`（Windows PowerShell 用 `Copy-Item .env.example .env`，Bash 用 `cp .env.example .env`），在本地编辑器中填写：

```dotenv
AGENT_API_KEY=你的临时凭据
AGENT_BASE_URL=https://你的服务商地址/v1
AGENT_MODEL=考试页面提供的模型名
WORKBENCH_PORT=4177
AGENT_TIMEOUT_SECONDS=600
```

`AGENT_BASE_URL` 是 API 基地址，CLI 会在其后请求 `/responses`。服务须支持 OpenAI Responses 流式协议和工具调用。仅提供 `/chat/completions` 的服务不适用。应用启动后才会在收到任务时调用模型。

```sh
docker compose up --build -d
docker compose ps
```

打开 <http://127.0.0.1:4177>。配置更新后运行 `docker compose up -d --force-recreate`。`docker compose down` 后再次启动仍可访问历史，`docker compose down -v` 会删除所有会话和文件。

## 使用与演示

1. 点击「新建会话」，选择「开发一个工具」或直接输入任务。发送后可展开执行日志。
2. 在另一个会话上传 `demo/` 下的工单和会议纪要，选择「整理工作材料」发起任务。
3. 右侧「材料」对应 `inputs/`，「成果」对应 `outputs/`。点击文件名预览文本，点击下载按钮获取文件。
4. 切换会话或关闭页面重开。回到原会话发送修改要求，继续同一 Codex 线程。

[演示脚本](demo/演示脚本.md) 包含两种任务的追问、预期结果和异常演示。端口默认为 4177。未配置模型时仍可浏览界面、管理会话和上传材料。

## 实现与取舍

- Node.js 24 提供 HTTP 和 SQLite，前端用原生 HTML、CSS 和 JS。浏览器按事件 ID 每 1.2 秒拉取进度，避免因为刷新丢失事件。
- 首轮从 `codex exec --json` 的 `thread.started` 保存真实线程 ID。之后使用 `codex exec resume`，保留线程记录、工作目录和 SQLite 数据。同一会话同一时间只接受一轮，最多并发四个会话。
- 停止和超时终止 CLI 进程组，任务状态、已接收日志和已写入文件会保留。服务非正常退出后标记遗留任务为中断，由用户发消息继续。
- 工作区由会话 ID 划分。上传禁止覆盖同名文件，文件接口只导出 `inputs/` 和 `outputs/` 内的常规文件。应用配置保存在服务端，模型凭据不传给前端，也不让常规 Agent shell 环境继承该变量。
- Docker 进程以非 root 用户运行，宿主端口仅发布到回环地址，根文件系统只读，不挂载 Docker socket 或宿主工作目录。Codex 启用 `workspace-write`，工具网络关闭。Compose 放宽容器默认的 seccomp、AppArmor 和系统路径规则，以允许 Codex 创建自身的 Linux 沙箱。部署定位是可信单用户，不能作为多租户安全边界或直接公开访问。

## 本地运行与验证

本地运行需要 Node.js 24、Codex CLI `0.171.0` 和任务所需工具。配置 `.env` 后运行 `npm start`，数据默认写入 `.workbench/`。Windows 全局 npm 安装的 Codex 会被自动识别。其他安装可通过 `CODEX_BIN` 指定 CLI 可执行文件的绝对路径。Docker 是交付运行环境。

```sh
npm run check
npm run smoke
docker compose config --quiet
```

`npm run smoke` 需要真实 Codex CLI 和 Python 3。它在本机启动确定性的 Responses 测试服务，真实调用 Codex、执行工具、生成文件并检查两轮续聊。报告工作区上传合成材料。测试覆盖重复上传、路径校验、两个并发任务、进程重启、鉴权错误、停止、超时和非正常退出恢复。GitHub Actions 工作流使用 Docker 运行这一套集成测试。浏览器自动化可使用 Playwright，在项目目录临时安装 `playwright` 后运行 `npx playwright install chromium` 和 `node scripts/browser-smoke.mjs`。

本地实际验证和截图见 [evidence](evidence/README.md)。接入考试服务时，在浏览器运行 `demo/` 中两条任务并各追问一次，即可另行保存真实模型的验证记录。

## 已知限制

- 单实例应用，无登录、队列或跨机器同步。禁止把未鉴权端口公开到公网。
- 单文件上传上限 20 MiB，内置文本预览上限 512 KiB。二进制文件可下载，复杂 PDF 或 Office 内容的解析依赖容器内工具。
- Agent 工具默认不能联网安装依赖。任务被中止时，文件保留在停止时的状态，应用不做文件回滚。
- 服务健康检查仅判断 HTTP 服务是否在线。模型兼容性、鉴权和工具可用性由真实任务确认。
