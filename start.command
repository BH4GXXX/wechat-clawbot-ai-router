#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '请先安装 Node.js 22 或更新版本。\n'
  exit 1
fi
if [ ! -f config.json ]; then node cli.mjs init || exit 1; fi
node cli.mjs doctor
printf '\n配置保存在 config.json。执行任务示例：node cli.mjs run --prompt "你好"\n按回车关闭。'
read -r answer
