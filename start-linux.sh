#!/usr/bin/env bash
# ============================================================
# gbmd-v3 - Linux 启动脚本（支持 start/stop/restart/status）
# 用法：
#   启动（默认）：./start-linux.sh [start] [--port 8642]
#   停止：        ./start-linux.sh stop
#   重启：        ./start-linux.sh restart [--port 8642]
#   状态：        ./start-linux.sh status
#   设置密码：    ./start-linux.sh --set-password "新密码"
# ============================================================
set -e
cd "$(dirname "$0")"

# ---------- 路径定义 ----------
LOG_FILE="server/server.log"
PID_FILE="/tmp/gbmd.pid"
NODE_BIN=""

# ---------- 查找 node ----------
find_node() {
  for c in node /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
    if command -v "$c" >/dev/null 2>&1; then
      NODE_BIN="$(command -v "$c")"
      return 0
    fi
  done
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    return 0
  fi
  return 1
}

if ! find_node; then
  echo "❌ 未找到 Node.js！请先安装："
  echo "   Debian/Ubuntu: sudo apt install nodejs npm"
  echo "   CentOS/RHEL:   sudo yum install nodejs npm"
  echo "   或从 https://nodejs.org 下载 LTS 版"
  exit 1
fi
echo "✓ Node.js: $NODE_BIN ($($NODE_BIN -v))"

# ---------- 功能函数 ----------
start_server() {
  local port_opt=""
  # 解析 --port 参数（如果有）
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        port_opt="$2"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done

  # 检查是否已运行
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "⚠️  服务已在运行（PID: $(cat "$PID_FILE")）"
    return 1
  fi

  # 准备启动命令
  local cmd="\"$NODE_BIN\" server/app.js"
  if [[ -n "$port_opt" ]]; then
    cmd="PORT=\"$port_opt\" $cmd"
  fi

  # 创建日志目录
  mkdir -p "$(dirname "$LOG_FILE")"

  echo "▶ 启动 gbmd-v3 ..."
  eval "nohup $cmd >> \"$LOG_FILE\" 2>&1 &"
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "✓ 服务已启动，PID: $pid"
  echo "  日志文件: $LOG_FILE"
  echo "  停止服务: ./$0 stop"
}

stop_server() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "⚠️  PID 文件不存在，服务可能未运行"
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "⚠️  进程 $pid 不存在，清理 PID 文件"
    rm -f "$PID_FILE"
    return 1
  fi

  echo "▶ 停止服务 (PID: $pid) ..."
  kill "$pid"
  local count=0
  while kill -0 "$pid" 2>/dev/null && [[ $count -lt 10 ]]; do
    sleep 1
    ((count++))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "  进程未响应，强制终止 ..."
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "✓ 服务已停止"
}

restart_server() {
  echo "▶ 重启服务 ..."
  stop_server || true
  start_server "$@"
}

status_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "✓ 服务正在运行，PID: $pid"
      return 0
    else
      echo "⚠️  PID 文件存在但进程已消失（可能异常退出）"
      rm -f "$PID_FILE"
      return 1
    fi
  else
    echo "❌ 服务未运行"
    return 1
  fi
}

# ---------- 参数解析 ----------
# 特殊处理：--set-password 作为独立操作
if [[ "$1" == "--set-password" ]]; then
  if [[ -z "$2" ]]; then
    echo "❌ 请提供新密码: --set-password \"新密码\""
    exit 1
  fi
  "$NODE_BIN" server/app.js --set-password "$2"
  echo "✓ 密码已设置"
  exit 0
fi

# 判断命令（第一个参数）
CMD="${1:-start}"               # 默认 start
if [[ "$CMD" == "--port" ]]; then
  # 兼容旧用法：直接以 --port 开头，视为 start
  CMD="start"
  shift
elif [[ "$CMD" == "start" || "$CMD" == "stop" || "$CMD" == "restart" || "$CMD" == "status" ]]; then
  shift  # 去掉命令，剩余参数留给 start
else
  # 未知参数，当做 start 并保留所有参数（可能是旧用法）
  CMD="start"
  # 不 shift，保留全部参数
fi

# ---------- 执行命令 ----------
case "$CMD" in
  start)
    start_server "$@"
    ;;
  stop)
    stop_server
    ;;
  restart)
    restart_server "$@"
    ;;
  status)
    status_server
    ;;
  *)
    echo "❌ 未知命令: $CMD"
    echo "可用命令: start, stop, restart, status"
    echo "旧用法: --port PORT 或 --set-password PASSWORD"
    exit 1
    ;;
esac