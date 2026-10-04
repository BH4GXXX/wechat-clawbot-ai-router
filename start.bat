@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本。
  pause
  exit /b 1
)
if not exist config.json node cli.mjs init
node cli.mjs doctor
echo 配置保存在 config.json。执行任务：node cli.mjs run --prompt "你好"
pause
