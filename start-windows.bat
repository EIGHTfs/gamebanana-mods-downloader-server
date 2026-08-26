@echo off
rem ============================================================
rem gbmd-v3 - Windows 启动脚本
rem 用法: start-windows.bat [--port 8642] [--set-password "新密码"]
rem   · 自动寻找 node（PATH 或常见安装路径）
rem   · 首次启动自动生成 config.json（缺失时）
rem   · 日志写入 server\server.log；窗口关闭即停止
rem ============================================================
cd /d "%~dp0"
setlocal

rem ---------- 找 node ----------
set NODE_BIN=
where node >nul 2>nul && set NODE_BIN=node
if "%NODE_BIN%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set NODE_BIN="%ProgramFiles%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%ProgramFiles(x86)%\nodejs\node.exe" set NODE_BIN="%ProgramFiles(x86)%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE_BIN="%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE_BIN%"=="" (
  echo [ERROR] 未找到 Node.js！请先安装：
  echo   从 https://nodejs.org 下载 Windows LTS 版并安装
  pause
  exit /b 1
)
echo [OK] Node.js: %NODE_BIN%

rem ---------- 参数 ----------
if "%1"=="--set-password" (
  %NODE_BIN% server\app.js --set-password "%2"
  echo [OK] 密码已设置
  pause
  exit /b 0
)

set PORT=
if "%1"=="--port" set PORT=%2

echo [START] 启动 gbmd-v3 ...
if not "%PORT%"=="" (
  set PORT=%PORT% && %NODE_BIN% server\app.js
) else (
  %NODE_BIN% server\app.js
)
pause
