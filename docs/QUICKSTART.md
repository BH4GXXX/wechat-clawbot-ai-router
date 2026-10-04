# 十分钟快速安装（macOS）

目标链路：

```text
微信 ClawBot ⇄ OpenClaw ⇄ 本机路由器 → Codex / DeepSeek / WorkBuddy / 豆包
```

本项目只调用电脑上已经登录的客户端或 CLI，不要求模型 API Key。macOS 已实机验证；Windows 代码已预留，但尚未完成实机验收。

## 1. 准备环境

需要：

- Node.js 22 或更高版本；运行 OpenClaw 时请满足 OpenClaw 自身的 Node 版本要求。
- OpenClaw。
- 至少一个已安装并登录的 AI 工具：ChatGPT/Codex、DeepSeek Harness、CodeBuddy CLI 或豆包。

先确认：

```sh
node --version
openclaw --version
```

## 2. 下载项目

```sh
git clone https://github.com/BH4GXXX/wechat-clawbot-ai-router.git
cd wechat-clawbot-ai-router
```

路由核心只使用 Node.js 内置模块，不需要执行 `npm install`。

## 3. 生成本机配置

```sh
npm run openclaw-config
```

会生成 `openclaw.generated.local.json5`。该文件已被 Git 忽略，并自动填入当前项目目录、用户目录和 Node 路径。

打开该文件：

1. 保留已经安装的 AI，把对应 `enabled` 改为 `true`。
2. 未安装的 AI 保持 `false`。
3. 如果工具不是默认安装位置，修改它的 `command`。
4. 建议至少启用两个 AI，以便一个不可用时自动切换。

默认只启用 Codex。配置中不应填写账号密码、Cookie、二维码或访问令牌。

## 4. 安装路由插件

```sh
openclaw plugins install --link --force --accept-capabilities "$PWD"
openclaw config patch --file openclaw.generated.local.json5
openclaw config validate
```

自然语言切换需要 `hooks.allowConversationAccess: true`。它允许本插件读取当前消息；插件仅在整条消息匹配“切换到 DeepSeek”等路由控制语句时直接处理。

## 5. 连接微信 ClawBot

```sh
openclaw plugins install --pin --accept-capabilities \
  --acknowledge-install-policy-warning '@tencent-weixin/openclaw-weixin@2.4.8'
openclaw channels login --channel openclaw-weixin --account default --verbose
```

用手机微信扫描终端二维码并确认。不要截图公开二维码，也不要把 OpenClaw 用户配置提交到 Git。

## 6. 启动常驻服务

```sh
openclaw daemon install --runtime node --runtime-path "$(command -v node)"
openclaw daemon restart
openclaw gateway status
```

看到 Gateway 正在运行且连接探测成功后即可使用。

## 7. 在微信中使用

先发送：

```text
/route status
```

切换 AI：

```text
/route codex
/route deepseek
/route workbuddy
/route doubao
/route auto
```

也可以直接说：

```text
切换到 DeepSeek
使用 WorkBuddy
请切换到豆包
恢复自动路由
```

然后直接发送任务。首选 AI 不可用时，路由器会继续尝试其他已启用工具。

## 8. 常用检查

```sh
openclaw config validate
openclaw gateway status
node cli.mjs doctor
npm run check-tools
```

这些检查不调用真实 AI。需要安装单个工具、配置 WorkBuddy 或豆包 CDP 时，继续阅读[完整安装说明](INSTALLATION.md)。故障切换行为见[故障切换说明](FAILOVER.md)。
