# 运行证据

以下结果来自 Windows 本机和隔离 Linux 虚拟机内的真实 Codex CLI 0.171.0。上游使用本地确定性 Responses 测试服务。测试服务提供固定工具调用，Codex 执行命令并写出实际文件。考试模型的能力和考试网关兼容性需要用考试凭据验证。

- [CLI 集成测试记录](smoke-result.txt)与 [浏览器测试记录](browser-result.txt)。
- [工作台首页](01-workbench.png)、[开发任务与运行日志](02-code-tests.png)、[报告预览和多会话](03-report-preview.png)。
- [生成的 Python 脚本](summary.py)、[测试](test_summary.py)、[样例数据](sample.csv)和[二次修改后的报告](report.md)。

在隔离 Linux 虚拟机内，Docker Engine 28.5.2 构建了工作台镜像，Compose 2.40.3 启动服务。容器内的两项任务和续聊通过验证，另以 HTTP 接口检查了 Compose 重启后的会话。见 [Docker 运行记录](container-result.txt)。
