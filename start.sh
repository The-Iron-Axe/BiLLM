#!/usr/bin/env bash
# billm 一键启动 (macOS / Linux)
# 用法:  bash start.sh   或   ./start.sh
#   环境变量可覆盖端口与行为:
#     BACKEND_PORT=8000  FRONTEND_PORT=5173  NO_BROWSER=1  SKIP_INSTALL=1

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
NO_BROWSER="${NO_BROWSER:-}"
SKIP_INSTALL="${SKIP_INSTALL:-}"

c_step() { printf "\033[36m==> %s\033[0m\n" "$*"; }
c_ok()   { printf "\033[32m    %s\033[0m\n" "$*"; }
c_warn() { printf "\033[33m    %s\033[0m\n" "$*"; }
c_fail() { printf "\033[31m[!] %s\033[0m\n" "$*"; exit 1; }

c_step "检查运行环境"
command -v python3 >/dev/null 2>&1 || c_fail "未检测到 python3，请先安装 Python 3.10+"
command -v node    >/dev/null 2>&1 || c_fail "未检测到 node，请先安装 Node 18+"
command -v npm     >/dev/null 2>&1 || c_fail "未检测到 npm"
c_ok "python3: $(command -v python3)"
c_ok "node:    $(command -v node)"
c_ok "npm:     $(command -v npm)"

c_step "检查 config.json"
if [ ! -f config.json ]; then
  if [ -f config.example.json ]; then
    cp config.example.json config.json
    c_warn "config.json 不存在，已从 config.example.json 复制。请按需编辑或在网页设置里填 API Key。"
  else
    c_warn "config.json 与 config.example.json 均不存在，首次启动时会自动生成默认配置。"
  fi
else
  c_ok "config.json 已存在"
fi

if [ -z "$SKIP_INSTALL" ]; then
  c_step "安装后端依赖 (pip)"
  python3 -m pip install --disable-pip-version-check -q -r requirements.txt
  c_ok "后端依赖就绪"

  if [ ! -d frontend/node_modules ]; then
    c_step "安装前端依赖 (npm install) - 首次启动较慢"
    (cd frontend && npm install --silent)
    c_ok "前端依赖就绪"
  else
    c_ok "前端依赖已存在，跳过 npm install"
  fi
else
  c_warn "已跳过依赖安装 (SKIP_INSTALL=1)"
fi

mkdir -p .runtime
BACKEND_LOG="$PROJECT_ROOT/.runtime/backend.log"
FRONTEND_LOG="$PROJECT_ROOT/.runtime/frontend.log"
BACKEND_PID="$PROJECT_ROOT/.runtime/backend.pid"
FRONTEND_PID="$PROJECT_ROOT/.runtime/frontend.pid"

cleanup() {
  echo ""
  c_step "停止服务"
  [ -f "$BACKEND_PID" ]  && kill "$(cat "$BACKEND_PID")"  2>/dev/null || true
  [ -f "$FRONTEND_PID" ] && kill "$(cat "$FRONTEND_PID")" 2>/dev/null || true
  rm -f "$BACKEND_PID" "$FRONTEND_PID"
  c_ok "已退出"
}
trap cleanup INT TERM EXIT

c_step "启动后端 (FastAPI) - http://localhost:$BACKEND_PORT  日志: $BACKEND_LOG"
( python3 -m uvicorn backend.main:app --host 127.0.0.1 --port "$BACKEND_PORT" --reload \
    > "$BACKEND_LOG" 2>&1 ) &
echo $! > "$BACKEND_PID"

c_step "启动前端 (Vite) - http://localhost:$FRONTEND_PORT  日志: $FRONTEND_LOG"
( cd frontend && npm run dev -- --port "$FRONTEND_PORT" > "$FRONTEND_LOG" 2>&1 ) &
echo $! > "$FRONTEND_PID"

if [ -z "$NO_BROWSER" ]; then
  c_step "等待前端就绪后打开浏览器"
  URL="http://localhost:$FRONTEND_PORT"
  for i in $(seq 1 60); do
    if curl -sSf "$URL" -o /dev/null 2>&1; then
      if command -v open >/dev/null 2>&1; then open "$URL"
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
      fi
      c_ok "已打开浏览器: $URL"
      break
    fi
    sleep 1
  done
fi

c_ok "运行中。按 Ctrl+C 停止两个服务。"
wait
