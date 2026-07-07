#!/bin/zsh

cd "$(dirname "$0")" || exit 1

PORT=5173
URL="http://localhost:${PORT}"

echo "正在启动镜头签..."
echo
echo "如果浏览器没有自动打开，请手动访问："
echo "${URL}"
echo
echo "保持这个窗口打开，网页才能继续运行。"
echo "想关闭时，回到这个窗口按 Control + C。"
echo

(sleep 1 && open "${URL}") &
python3 -m http.server "${PORT}" --bind 127.0.0.1
