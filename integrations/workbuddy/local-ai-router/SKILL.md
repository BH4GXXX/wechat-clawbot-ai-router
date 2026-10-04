---
name: local-ai-router
description: 将用户要求交给本机其他 AI 的任务转交给本机 AI 路由器，例如“用本机 AI”“交给 Codex”或“通过路由器执行”；将真实执行结果回复到当前 WorkBuddy 对话。
---

# 本机 AI 路由

此技能供 WorkBuddy 调用用户电脑上的路由器。微信消息仍由 WorkBuddy 已有的 ClawBot 连接收发。

1. 读取本技能目录的 `settings.json`，获取 Node 可执行路径和路由器目录。不要把这些路径误当成用户任务的工作目录。
2. 初次使用或排查环境时，用 shell 工具执行：`"<nodeBinary>" "<本技能绝对目录>/scripts/run.mjs" --doctor`。这只检查命令与配置，不证明 AI 已登录或有额度。
3. 将任务写入一个 UTF-8 JSON 临时文件。字段为 `id`、`sessionId`（可选）、`prompt` 和 `provider`（可选）。`id` 应使用当前消息的稳定 ID；拿不到时为本次调用生成一次 UUID，并在重试时沿用。不得把不同用户的任务复用同一 sessionId。没有可靠会话 ID 时省略，必要上下文由 prompt 显式提供。指定 Codex 时 provider 为 `codex`。
4. 用文件写入工具创建 JSON，保留真实任务文本，避免把用户文字插入 shell 命令。执行 `"<nodeBinary>" "<本技能绝对目录>/scripts/run.mjs" --request "<请求文件绝对路径>"`，等待进程完成。
5. 返回 JSON 中的 `text`，说明实际 provider。若失败，解释错误并保持原任务 ID；不要为了重试换 ID，不要把不确定或失败的任务说成成功。完成后可删除请求临时文件。

不要把 WorkBuddy 本身设为路由备用项，以免递归调用本技能。当前技能不操作豆包或 ChatGPT 的桌面窗口；可用工具由路由器配置决定。遇到权限确认，让用户在电脑端处理，不添加跳过权限参数。

此技能依赖 WorkBuddy 能够调用本地工具；WorkBuddy 自身额度或服务不可用时，不能保证技能仍能启动。
