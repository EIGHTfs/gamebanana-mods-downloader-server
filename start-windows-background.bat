@echo off
rem ============================================================
rem gbmd-v3 - Windows 后台启动脚本（最小化窗口后台运行）
rem 用法: start-windows-background.bat
rem   · 后台运行（最小化），日志写入 server\server.log
rem   · 停止：任务管理器结束 node.exe 或重启
rem ============================================================
cd /d "%~dp0"
setlocal

set NODE_BIN=
where node >nul 2>nul && set NODE_BIN=node
if "%NODE_BIN%"=="" if exist "%ProgramFiles%\nodejs\node.exe" set NODE_BIN="%ProgramFiles%\nodejs\node.exe"
if "%NODE_BIN%"=="" if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE_BIN="%LOCALAPPDATA%\Programs\nodejs\node.exe"
if "%NODE_BIN%"=="" (
  echo [ERROR] 未找到 Node.js！
  pause
  exit /b 1
)

echo [START] 后台启动 gbmd-v3 ...
start "" /min cmd /c "%NODE_BIN% server\app.js >> server\server.log 2>&1"
echo [OK] 已在后台启动，访问 http://127.0.0.1:8642
echo      日志: server\server.log
