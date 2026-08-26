#!/usr/bin/env bash
# ============================================================
# gbmd-v3 - Linux 启动脚本
# 用法: ./start-linux.sh [--port 8642] [--set-password "新密码"]
#   · 自动寻找 node（PATH → /usr/bin → /usr/local/bin → /opt/node*/bin）
#   · 首次启动自动生成 config.json（缺失时）
#   · 日志写入 server/server.log；前台运行 Ctrl+C 停止
# ============================================================
set -e
cd "$(dirname "$0")"

# ---------- 找 node ----------
NODE_BIN=""
for c in node /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
  if command -v "$c" >/dev/null 2>&1; then NODE_BIN="$(command -v "$c")"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  # 最后再试 PATH 里的 node
  if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; fi
fi
if [ -z "$NODE_BIN" ]; then
  echo "❌ 未找到 Node.js！请先安装："
  echo "   Debian/Ubuntu: sudo apt install nodejs npm"
  echo "   CentOS/RHEL:   sudo yum install nodejs npm"
  echo "   或从 https://nodejs.org 下载 LTS 版"
  exit 1
fi
echo "✓ Node.js: $NODE_BIN ($($NODE_BIN -v))"

# ---------- 端口 ----------
PORT=""
if [ "$1" = "--port" ]; then PORT="$2"; shift 2; fi

# ---------- 首次设置密码 ----------
if [ "$1" = "--set-password" ]; then
  "$NODE_BIN" server/app.js --set-password "$2"
  echo "✓ 密码已设置"
  exit 0
fi

echo "▶ 启动 gbmd-v3 ..."
if [ -n "$PORT" ]; then
  PORT="$PORT" "$NODE_BIN" server/app.js
else
  "$NODE_BIN" server/app.js
fi
