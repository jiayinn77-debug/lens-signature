#!/bin/zsh

cd "$(dirname "$0")" || exit 1

PORT=5173
LOCAL_URL="http://localhost:${PORT}/mobile/"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"
PHONE_URL="http://${LAN_IP}:${PORT}/mobile/"

echo "正在启动手机版镜头签..."
echo
echo "电脑上打开："
echo "${LOCAL_URL}"
echo
if [ -n "${LAN_IP}" ]; then
  echo "手机和电脑连接同一个 Wi-Fi 后，在手机浏览器打开："
  echo "${PHONE_URL}"
else
  echo "没有自动找到电脑局域网 IP。你可以在 Wi-Fi 设置里查看 IP 后访问："
  echo "http://你的电脑IP:${PORT}/mobile/"
fi
echo
echo "保持这个窗口打开，网页才能继续运行。"
echo "想关闭时，回到这个窗口按 Control + C。"
echo

(sleep 1 && open "${LOCAL_URL}") &
python3 -m http.server "${PORT}" --bind 0.0.0.0
