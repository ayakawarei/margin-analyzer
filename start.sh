#!/bin/bash
# 日股信用残分析工具 —— 一键启动
# 用法：双击本文件，或在终端执行 ./start.sh
# 浏览器会自动打开 http://127.0.0.1:8848

cd "$(dirname "$0")" || exit 1

PY=""
for c in \
  "./.venv/bin/python3" \
  "python3"
do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "找不到 python3，请先安装 Python 3"
  read -r -p "按回车退出…" _
  exit 1
fi

# 依赖检查（只提示，不自动安装）
"$PY" - <<'EOF'
import importlib.util as u, sys
missing = [m for m in ("pdfplumber",) if not u.find_spec(m)]
if missing:
    print("缺少依赖: " + ", ".join(missing))
    print("请运行: " + sys.executable + " -m pip install " + " ".join(missing))
    sys.exit(1)
EOF
if [ $? -ne 0 ]; then
  read -r -p "按回车退出…" _
  exit 1
fi

PORT=8848
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT+1))
done

echo ""
echo "  日股信用残分析工具"
echo "  ------------------------------------------------"
echo "  地址: http://127.0.0.1:$PORT"
echo "  停止: 在本窗口按 Ctrl+C"
echo ""

( sleep 1
  if command -v open >/dev/null 2>&1; then
    open "http://127.0.0.1:$PORT"
  fi ) &

exec "$PY" server.py "$PORT"
