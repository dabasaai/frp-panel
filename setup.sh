#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=== FRP Panel 安裝腳本 ==="

# 建立 conf.d 目錄
mkdir -p conf.d

# 建立 .env（如果不存在）
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[OK] .env 已建立（請修改 PANEL_PASSWORD）"
else
  echo "[SKIP] .env 已存在"
fi

# 建立 frpc.toml（如果不存在）
if [ ! -f frpc.toml ]; then
  cp frpc.toml.example frpc.toml
  echo "[OK] frpc.toml 已建立"
else
  echo "[SKIP] frpc.toml 已存在"
fi

# 建置並啟動
echo ""
echo "=== 建置並啟動 Docker 容器 ==="
sudo docker compose up -d --build

echo ""
echo "=== 完成 ==="
echo "面板網址: http://localhost:9090"
echo ""
echo "如需修改設定，編輯 .env 後執行："
echo "  sudo docker compose up -d --force-recreate"
