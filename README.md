# FRP Panel

輕量 FRP 隧道自助管理面板，透過 Web UI 新增/刪除 frpc 隧道，支援 HTTP、TCP、UDP。

## 功能

- Web 面板管理 frpc 隧道（新增、刪除、自動 reload）
- 支援 subdomain 模式（`*.gsct.tw`）
- 產生 frpc.toml 供其他設備下載使用
- 可選：透過 frps Admin API 顯示所有隧道狀態

## 快速安裝（Docker）

```bash
git clone <repo-url> frp-panel
cd frp-panel
./setup.sh
```

腳本會自動建立 `.env`、`frpc.toml` 並啟動 Docker 容器。

啟動後編輯 `.env` 修改密碼，再重建容器：

```bash
vi .env                                      # 修改 PANEL_PASSWORD
sudo docker compose up -d --force-recreate   # 套用設定
```

面板預設在 `http://localhost:9090`。

## 設定說明

### .env

| 變數 | 說明 | 預設 |
|------|------|------|
| `PORT` | 面板監聽 port | `9090` |
| `PANEL_PASSWORD` | 面板登入密碼 | `changeme` |
| `FRP_SERVER_ADDR` | frps 伺服器位址 | `gsct.tw` |
| `FRP_SERVER_PORT` | frps 連線 port | `7000` |
| `FRP_AUTH_TOKEN` | frps 驗證 token | - |
| `DOMAINS` | 可用域名（逗號分隔） | `gsct.tw` |
| `FRPS_ADMIN_URL` | frps Admin API 網址（選填） | - |
| `FRPS_ADMIN_USER` | frps Admin 帳號（選填） | - |
| `FRPS_ADMIN_PASS` | frps Admin 密碼（選填） | - |

設定 `FRPS_ADMIN_*` 後，面板會顯示「所有隧道」分頁，可查看 frps 上所有已註冊的隧道狀態。未設定則只能管理本機隧道。

### frpc.toml

由 `frpc.toml.example` 複製而來，一般不需修改。面板新增的隧道設定檔會放在 `conf.d/` 目錄下，frpc 透過 `includes` 自動載入。

## 架構

```
                    使用者
                      |
               Caddy (*.gsct.tw)
              /       |        \
     frp-panel    frps:8880    其他服務
     (:9090)         |
                   frpc
                  conf.d/*.toml
```

- **Caddy** — 反向代理，萬用憑證 `*.gsct.tw`
- **frps** — FRP 伺服器，需啟用 `subDomainHost = "gsct.tw"`
- **frpc** — 隨面板容器啟動，自動載入 `conf.d/` 內的隧道設定
- **面板** — Node.js + Express，提供 Web UI 管理隧道

## 注意事項

### frps 必須啟用 subDomainHost

在 `frps.toml` 中加入：

```toml
subDomainHost = "gsct.tw"
```

啟用後，frpc 的 HTTP 隧道必須使用 `subdomain` 而非 `customDomains`。如果原本的 frpc 設定使用 `customDomains`，需要改為 `subdomain`：

```toml
# 改前（會報錯）
[[proxies]]
name = "myapp"
type = "http"
localPort = 3000
customDomains = ["myapp.gsct.tw"]

# 改後
[[proxies]]
name = "myapp"
type = "http"
localPort = 3000
subdomain = "myapp"
```

### Caddy 需設定萬用字元

Caddyfile 中使用 `*.gsct.tw` 才能讓面板新增的任意子域名自動生效：

```
*.gsct.tw {
    tls /path/to/fullchain.cer /path/to/key.key

    # frp-panel
    @frppanel host frp.gsct.tw
    handle @frppanel {
        reverse_proxy 127.0.0.1:9090
    }

    # 其他 named host 可在此加入 @matcher

    # 預設：轉給 frps
    handle {
        reverse_proxy 127.0.0.1:8880 {
            header_up Host {host}
        }
    }
}
```

### Docker 使用 network_mode: host

容器使用 `network_mode: host`，直接共用主機網路，確保 frpc 能存取本機服務及 frps。無需額外設定 port mapping。

## 常用指令

```bash
# 查看容器狀態
sudo docker ps --filter name=frp-panel

# 查看 log
sudo docker logs frp-panel --tail 50

# 重建容器（修改 .env 或程式碼後）
sudo docker compose up -d --build --force-recreate

# 停止
sudo docker compose down
```
