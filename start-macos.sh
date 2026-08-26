#!/usr/bin/env bash
# ============================================================
# gbmd-v3 - macOS 启动脚本
# 用法: ./start-macos.sh [--port 8642] [--set-password "新密码"]
#   · 自动寻找 node（PATH → /usr/local/bin → /opt/homebrew/bin → 常见 nvm 路径）
#   · 首次启动自动生成 config.json（缺失时）
#   · 日志写入 server/server.log；前台运行 Ctrl+C 停止
# ============================================================
set -e
cd "$(dirname "$0")"

# ---------- 找 node（含 Homebrew / nvm）----------
NODE_BIN=""
for c in node /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then
    if command -v "$c" >/dev/null 2>&1; then NODE_BIN="$(command -v "$c")"; else NODE_BIN="$c"; fi
    break
  fi
done
if [ -z "$NODE_BIN" ]; then
  echo "❌ 未找到 Node.js！请先安装："
  echo "   brew install node"
  echo "   或从 https://nodejs.org 下载 macOS LTS 版"
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
