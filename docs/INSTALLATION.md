# 本机工具安装与操作记录

本文记录 2026-10-03 在当前 Mac 上实际安装、配置和验证过的工具。目标是换电脑或重装后可以按相同步骤恢复环境。

文档只记录程序路径、版本、配置方式和验证命令。登录令牌、二维码链接、账号信息和会话内容不得写入仓库。

后续维护约定：每次新增、升级或替换工具，都在本文同步更新版本、安装命令、绝对入口、登录步骤、路由配置、验证结果和回退注意事项；只完成安装而未实测的项目必须明确标为“未验证”。

## 0. 从零安装到微信可用

下面是新电脑的完整主线。macOS 已实机验证；Windows 代码已预留，但安装路径、进程停止和微信往返仍需 Windows 实机验证。

### 0.1 克隆工程并准备 Node.js

```sh
git clone https://github.com/BH4GXXX/wechat-clawbot-ai-router.git
cd wechat-clawbot-ai-router
node --version
```

路由核心要求 Node.js 22+，只使用 Node 内置模块，不需要 `npm install`。OpenClaw 2026.9.8 另要求 Node.js `>=24.16.0 <25` 或 `>=26.1.0`；当前 Mac 使用 Node 24.21.0。若系统里的 Node 版本不满足 OpenClaw，请按本文第 8 节安装独立 Node，不必替换其他 AI 工具使用的 Node。

### 0.2 安装并登录至少一个 AI 工具

可以只配置其中一个，建议至少两个用于故障接管：

1. Codex：安装并登录 ChatGPT.app，确认应用内置 Codex CLI 路径，见第 3 节。
2. DeepSeek：安装并登录 DeepSeek Harness.app，见第 4 节。
3. WorkBuddy：安装完整 CodeBuddy CLI 并执行 `/login`，见第 6 节。
4. 豆包：安装并登录豆包客户端，再安装 `doubao-cli`，见第 7 节。

本项目不保存这些工具的账号密码，也不调用模型 API；每个 CLI 复用其客户端登录状态。

### 0.3 创建本机路由配置

```sh
node cli.mjs init --config config.json
```

`init` 不会覆盖已有文件。然后编辑 `config.json`：

- 保留已经安装的 provider，未安装的设为 `"enabled": false`；
- 将 `command`、`cwd`、适配器路径写成当前电脑的绝对路径；
- 生产环境使用 `"failoverPolicy": "availability-first"`；
- 优先级数字越小越先调用；
- Codex 建议设置 `"idleTimeoutSeconds": 60`，断网挂起后尽快接管。

检查配置和离线回归：

```sh
node cli.mjs doctor --config config.json
npm run check-tools
npm test
```

### 0.4 安装 OpenClaw 并链接路由插件

先按第 8 节安装满足版本要求的 OpenClaw，然后执行：

```sh
openclaw plugins install --link --force --accept-capabilities "$PWD"
cp openclaw.config.example.json5 /tmp/wechat-router-openclaw.json5
```

编辑 `/tmp/wechat-router-openclaw.json5`，把所有 `/Users/amirliu/...` 改为当前电脑的绝对路径，删除或禁用未安装的 provider。然后合并配置并校验：

```sh
openclaw config patch --file /tmp/wechat-router-openclaw.json5
openclaw config validate
```

模板会把 OpenClaw 默认模型设置为 `jijin-ai-router/auto`，使微信消息直接进入本机路由器，不先经过另一个模型。
模板还为本插件启用 `hooks.allowConversationAccess`，这是识别“切换到 DeepSeek”等自然语言控制所必需的 OpenClaw 权限；插件仅在整条当前消息匹配路由控制时拦截。

### 0.5 安装微信插件并扫码绑定

```sh
openclaw plugins install --pin --accept-capabilities \
  --acknowledge-install-policy-warning '@tencent-weixin/openclaw-weixin@2.4.8'
openclaw channels login --channel openclaw-weixin --account default --verbose
```

用手机微信扫描终端二维码并确认。二维码、登录 URL、令牌和 OpenClaw 用户配置都不得提交到 Git。

### 0.6 安装常驻服务

macOS：

```sh
openclaw daemon install --runtime node --runtime-path "$(command -v node)"
openclaw daemon restart
openclaw daemon status
openclaw channels status --probe --json
```

应看到 Gateway `running`、连接探测成功、微信通道已配置且运行中。Windows 应使用 OpenClaw 提供的计划任务服务安装方式；本项目尚未完成 Windows 实机验收。

### 0.7 从微信验收与切换路由

依次发送：

```text
/route status
/route codex
只回复 ROUTER_OK
/route auto
```

也可说“切换到 DeepSeek”“使用 WorkBuddy”“请切换到豆包”或“恢复自动路由”。切换只改变当前微信会话的首选 AI；首选项不可用时仍继续其他 provider。

电脑端同时确认 Gateway 日志出现入站、`jijin-ai-router/auto` 调用和 `outbound: text sent OK`。只有手机实际收到回复才算微信端到端通过。

## 1. 当前环境清单

| 组件 | 当前版本 | 本机入口 | 状态 |
| --- | --- | --- | --- |
| 项目路由器 | 0.3.0 | `node cli.mjs` | 已完成，49 项测试通过 |
| Homebrew Node.js | 23.7.0 | `/opt/homebrew/opt/node/bin/node` | 路由器和豆包适配器使用 |
| 独立 Node.js | 24.21.0 | `~/.local/node/current/bin/node` | OpenClaw 使用 |
| Codex CLI | 0.159.2 | `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` | 已接入；额度状态由账号决定 |
| DeepSeek Harness CLI | 0.2.0-rc.2 | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` | 已接入并验证 |
| WorkBuddy 客户端 | 2.147.0 | `/Applications/WorkBuddy.app` | 已绑定微信 ClawBot |
| WorkBuddy / CodeBuddy CLI | 2.160.0 | `~/.local/bin/codebuddy` | 已单独登录、接入并验证 |
| 豆包客户端 | 2.31.4 | `/Applications/豆包.app` | 已登录 |
| doubao-cli | 0.13.0 | `~/.local/bin/doubao` | 已接入；使用前需要开启 CDP |
| OpenClaw | 2026.9.8 | `~/.local/node/current/bin/openclaw` | 已安装、加载路由插件并以 LaunchAgent 常驻 |
| 腾讯微信插件 | 2.4.8 | `@tencent-weixin/openclaw-weixin` | 已安装、扫码绑定，通道在线 |

路由器当前选择顺序为：`Codex(10) → DeepSeek(15) → WorkBuddy(18) → 豆包(20)`。

## 2. 路由器工程

工程目录：

```text
/Users/amirliu/1-Project/jijin/wechat-ai-router
```

路由核心只使用 Node.js 内置模块，不需要执行 `npm install`。初始化和检查：

```sh
cd /Users/amirliu/1-Project/jijin/wechat-ai-router
node cli.mjs init       # 仅在没有 config.json 时执行；不会覆盖已有配置
node cli.mjs doctor
npm test
npm run check-tools
```

`config.json` 保存每个 CLI 的绝对路径，避免 WorkBuddy、OpenClaw 和终端的 PATH 不一致。生产状态位于 `~/.jijin-ai-router`。不要为了排错删除 `state.json`；遇到锁文件时先确认路由器和 AI 子进程均已停止。

## 3. Codex CLI

Codex 来自 ChatGPT.app，不另外安装：

```text
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
```

检查版本：

```sh
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version
```

路由器使用 `codex exec --json --skip-git-repo-check -s read-only -`，任务从 stdin 输入。登录和额度由 ChatGPT/Codex 自身管理；额度耗尽时路由器会把它标为暂时不可用并尝试下一个 provider。

## 4. DeepSeek Harness CLI

安装 DeepSeek Harness.app 后使用其内置 CLI：

```text
/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh
```

默认 headless profile 要求 API Key。项目通过 [dsh-headless-account.yml](../adapters/dsh-headless-account.yml) 将 provider 改为 `deepseek-account`，复用桌面客户端登录态，不在路由器保存密钥。

关键配置：

```text
--profile headless --patch <项目>/adapters/dsh-headless-account.yml -
DSH_PERMISSION_MODE=read-only
```

检查命令和工作目录用 `node cli.mjs doctor`；真实验证用固定任务 ID，避免重复产生请求。

## 5. WorkBuddy 技能入口

这是当前已经可用的过渡链路：

```text
微信 ClawBot → WorkBuddy → local-ai-router 技能 → 本机路由器
```

技能包：

```text
integrations/workbuddy/local-ai-router.zip
```

安装步骤：

1. 在 WorkBuddy 的技能页面选择添加或上传技能。
2. 导入上述 zip 并启用。
3. 检查技能目录 `settings.json` 中的 `nodeBinary`、`routerRoot` 和 `configFile`。
4. 当前安装位置为 `~/.workbuddy/skills/local-ai-router`。

诊断入口：

```sh
/opt/homebrew/bin/node ~/.workbuddy/skills/local-ai-router/scripts/run.mjs --doctor
```

技能方式仍依赖 WorkBuddy 模型先接收微信消息。WorkBuddy 服务不可用时，这条链路无法启动路由器。

## 6. WorkBuddy / CodeBuddy CLI

WorkBuddy.app 自带 CLI 2.147.0，但应用包只包含无界面 bundle，直接启动交互模式会报缺少 `dist/codebuddy`。本机使用内置安装器安装了完整 CLI：

```sh
env CODEBUDDY_FORCE_HEADLESS_BUNDLE=1 \
  /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy \
  install latest
```

安装结果：

```text
~/.local/bin/codebuddy -> ~/.local/share/codebuddy/versions/2.160.0/codebuddy
```

首次登录：

```sh
cd /Users/amirliu/1-Project/jijin/wechat-ai-router
codebuddy
# 首次询问目录信任时选择 “Trust folder only”
# 输入 /login
# 选择 Chinese Site，在浏览器完成授权
# 终端出现 Successfully signed in 后输入 /exit
```

路由器将 WorkBuddy 限制为纯模型执行器，并把每条微信任务保存为独立会话：

```text
CODEBUDDY_CONFIG_DIR=/Users/amirliu/.workbuddy
--print --output-format text --tools '' --session-id wechat-<任务ID> --max-turns 1
```

`--tools ''` 必须保留，否则 WorkBuddy 可能再次调用 `local-ai-router` 技能形成递归。`CODEBUDDY_CONFIG_DIR` 指向桌面端使用的 `.workbuddy`，避免任务只留在 CLI 默认的 `.codebuddy` 目录。2026-10-03 已验证 CLI 返回 `WORKBUDDY_OK`，路由器 provider 返回 `ROUTER_WORKBUDDY_OK`；任务持久化验证返回 `WORKBUDDY_SHARED_VISIBLE_OK`，会话文件已写入 `.workbuddy/projects`。

## 7. 豆包与 doubao-cli

豆包没有供本项目使用的官方本地 CLI。当前通过社区项目 `doubao-cli` 的 CDP 通道控制已登录的豆包客户端：

```sh
npm install --global doubao-cli@latest
ln -s /opt/homebrew/opt/node/lib/node_modules/doubao-cli/bin/doubao.mjs ~/.local/bin/doubao
doubao --version
```

每次豆包正常重启后需要重新开启调试通道：

```sh
doubao cdp launch
doubao cdp status --json
```

验证消息：

```sh
doubao sessions create "只回复 ROUTER_OK" --wait --json
```

注意事项：

- CDP 默认监听 `127.0.0.1:9225`，开启期间本机其他进程也能无认证操作豆包，验证完应关闭。
- `sessions create --help` 会被当作真实消息发送，不要用它探测帮助。
- 路由器通过 [doubao.mjs](../adapters/doubao.mjs) 转换豆包返回结构，并固定使用 Homebrew Node 23.7.0。
- 详细排错与恢复方式见 [豆包接入说明](DOUBAO.md)。

## 8. OpenClaw

OpenClaw 要求 Node.js `>=24.16.0 <25` 或 `>=26.1.0`，因此没有使用现有 Homebrew Node 23.7.0。本机安装了 nodejs.org 的 macOS arm64 预编译 Node 24.21.0：

```text
~/.local/node/node-v24.21.0-darwin-arm64
~/.local/node/current -> node-v24.21.0-darwin-arm64
```

安装 OpenClaw 时使用 Node 24 自带的 npm，并允许必要的安装脚本：

```sh
~/.local/node/current/bin/npm install -g \
  --allow-scripts=@google/genai,esbuild,koffi,protobufjs,openclaw \
  openclaw
~/.local/node/current/bin/openclaw --version
```

当前已安装 `OpenClaw 2026.9.8`。项目插件配置模板为 [openclaw.config.example.json5](../openclaw.config.example.json5)。本机已经链接项目插件、合并配置，并把默认模型设置为 `jijin-ai-router/auto`。本地 OpenClaw 调用已返回 `OPENCLAW_ROUTER_OK`。

官方微信插件和常驻服务的实际安装命令：

```sh
~/.local/node/current/bin/openclaw plugins install --pin --accept-capabilities \
  --acknowledge-install-policy-warning '@tencent-weixin/openclaw-weixin@2.4.8'
~/.local/node/current/bin/openclaw channels login \
  --channel openclaw-weixin --account default --verbose
~/.local/node/current/bin/openclaw daemon install --runtime node \
  --runtime-path /Users/amirliu/.local/node/current/bin/node
```

扫码成功后凭据由微信插件单独保存，不要复制到仓库。检查常驻服务：

```sh
~/.local/node/current/bin/openclaw gateway status --json
~/.local/node/current/bin/openclaw channels status --probe --json
```

2026-10-03 已确认 Gateway 正在运行、RPC 正常，微信账号已配置并处于运行状态且没有错误。同日完成手机微信首次往返：路由器通过 Codex 返回 `WECHAT_ROUTE_OK`，微信插件记录 `text sent OK`。

本项目注册的是 CLI backend，不是 OpenClaw 模型目录供应商；因此 `openclaw models list --provider jijin-ai-router` 不能作为检查命令。`openclaw models status --json` 应解析出默认模型 `jijin-ai-router/auto`，但其中的认证状态可能显示无法确认，因为各 CLI 的登录不存放在 OpenClaw 凭据仓库。实际可用性以 `openclaw agent` 调用和路由器状态为准。

## 9. 微信 ClawBot 状态

当前状态：

- WorkBuddy 客户端已经绑定微信 ClawBot，技能路线可继续使用。
- 独立路由器的 OpenClaw 微信通道已扫码绑定，长轮询服务在线。
- 手机微信 → OpenClaw → 独立路由器 → Codex → 手机微信的完整往返已验证通过。

独立绑定步骤与验收方法见 [微信 ClawBot 接入](CLAWBOT.md)。绑定时生成的二维码、临时登录 URL 和令牌不得写入本文件或提交 Git。

## 10. 安装后统一检查

不调用真实 AI：

```sh
node cli.mjs doctor
npm run check-tools
npm test
```

按需进行真实验证，每个工具只调用一次并使用固定任务 ID：

```sh
node cli.mjs run --provider workbuddy \
  --id workbuddy-router-verification-20261003 \
  --prompt "只回复 ROUTER_WORKBUDDY_OK，不要调用任何工具。" --json
```

真实测试结果记录在本机忽略文件 `verification.local.json`。只有其中明确记录入站、路由结果和 `text sent OK` 的项目才算手机微信往返通过；普通进程级成功不能替代这项证据。

## 11. Windows 状态

项目代码包含 Windows 命令包装器和进程终止逻辑，但尚未在 Windows 实机安装或验证以上工具。迁移到 Windows 时应重新记录每个 CLI 的绝对路径、登录方式、进程树停止行为和微信往返结果，不能直接套用本文的 macOS 路径。
