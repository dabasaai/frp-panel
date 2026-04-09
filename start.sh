#!/bin/sh

# 啟動 frpc（背景執行）
frpc -c /app/frpc.toml &
echo "[frpc] 已啟動"

# 啟動 Node.js 面板
exec node server.js
