#!/bin/bash
set -e

CADDYFILE="/home/digitalent/Developer/ngrok2frp/Caddyfile"

echo "=== 將 frp.gsct.tw 加入 Caddy 設定 ==="

# 檢查是否已經有 frp.gsct.tw
if grep -q 'frp.gsct.tw' "$CADDYFILE"; then
  echo "[SKIP] frp.gsct.tw 已存在於 Caddyfile"
else
  # 在域名清單中加入 frp.gsct.tw
  sed -i 's|serverx3650_web.gsct.tw {|frp.gsct.tw,\nserverx3650_web.gsct.tw {|' "$CADDYFILE"

  # 在 @dashboard handle 之前加入 frp-panel 的 handle
  sed -i '/@dashboard host serverx3650_web.gsct.tw/i\\t@frppanel host frp.gsct.tw\n\thandle @frppanel {\n\t\treverse_proxy 127.0.0.1:9090\n\t}\n' "$CADDYFILE"

  echo "[OK] Caddyfile 已更新"
fi

echo ""
cat "$CADDYFILE"

echo ""
echo "=== 重載 Caddy ==="
sudo /usr/local/bin/caddy reload --config "$CADDYFILE" --adapter caddyfile

echo ""
echo "=== 完成 ==="
echo "https://frp.gsct.tw 應已可使用"
