require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 設定 ---
const PORT = process.env.PORT || 9090;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'frp2026';
const CONFD_DIR = path.join(__dirname, 'conf.d');
const FRPC_MAIN = path.join(__dirname, 'frpc.toml');

// 可用域名（從環境變數 DOMAINS 讀取，逗號分隔）
const DOMAINS = process.env.DOMAINS
  ? process.env.DOMAINS.split(',').map(d => d.trim())
  : ['example.com'];

// 確保 conf.d 存在
if (!fs.existsSync(CONFD_DIR)) fs.mkdirSync(CONFD_DIR, { recursive: true });

// --- 簡易 session 認證 ---
const sessions = new Set();

function requireAuth(req, res, next) {
  const sid = req.headers.cookie?.match(/sid=([^;]+)/)?.[1];
  if (sid && sessions.has(sid)) return next();
  if (req.path === '/api/login') return next();
  return res.status(401).json({ error: '未登入' });
}

app.post('/api/login', (req, res) => {
  if (req.body.password === PANEL_PASSWORD) {
    const sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.add(sid);
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.json({ ok: true });
  }
  res.status(403).json({ error: '密碼錯誤' });
});

app.use('/api', requireAuth);

// --- API ---

// 取得可用域名列表
app.get('/api/domains', (_req, res) => {
  res.json(DOMAINS);
});

// 列出所有 proxy
app.get('/api/proxies', (_req, res) => {
  const files = fs.readdirSync(CONFD_DIR).filter(f => f.endsWith('.toml'));
  const proxies = files.map(f => {
    const content = fs.readFileSync(path.join(CONFD_DIR, f), 'utf-8');
    return { filename: f, content };
  });
  res.json(proxies);
});

// 新增 proxy
app.post('/api/proxies', (req, res) => {
  const { name, type, localPort, localIP, domain, subdomain, remotePort } = req.body;

  // 驗證
  if (!name || !type || !localPort) {
    return res.status(400).json({ error: '名稱、類型、本地 Port 為必填' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: '名稱僅允許英數、底線、連字號' });
  }

  const filename = `${name}.toml`;
  const filepath = path.join(CONFD_DIR, filename);
  if (fs.existsSync(filepath)) {
    return res.status(409).json({ error: '此名稱已存在' });
  }

  let toml = `[[proxies]]\nname = "${name}"\ntype = "${type}"\n`;
  toml += `localIP = "${localIP || '127.0.0.1'}"\n`;
  toml += `localPort = ${parseInt(localPort, 10)}\n`;

  if (type === 'http' || type === 'https') {
    const fullDomain = subdomain ? `${subdomain}.${domain}` : domain;
    toml += `customDomains = ["${fullDomain}"]\n`;
  } else if (type === 'tcp' || type === 'udp') {
    if (remotePort) toml += `remotePort = ${parseInt(remotePort, 10)}\n`;
  }

  fs.writeFileSync(filepath, toml);
  reloadFrpc();
  res.json({ ok: true, filename, content: toml });
});

// 刪除 proxy
app.delete('/api/proxies/:filename', (req, res) => {
  const filepath = path.join(CONFD_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: '找不到' });
  }
  fs.unlinkSync(filepath);
  reloadFrpc();
  res.json({ ok: true });
});

// 產生遠端 frpc.toml 下載
app.post('/api/generate', (req, res) => {
  const { name, type, localPort, localIP, domain, subdomain, remotePort } = req.body;

  let toml = `# frpc 設定檔 — 由 FRP Panel 產生\n`;
  toml += `serverAddr = "${process.env.FRP_SERVER_ADDR || '172.233.87.234'}"\n`;
  toml += `serverPort = ${process.env.FRP_SERVER_PORT || 7000}\n`;
  toml += `auth.method = "token"\n`;
  toml += `auth.token = "${process.env.FRP_AUTH_TOKEN || ''}"\n\n`;
  toml += `log.to = "console"\nlog.level = "info"\n\n`;

  toml += `[[proxies]]\nname = "${name}"\ntype = "${type}"\n`;
  toml += `localIP = "${localIP || '127.0.0.1'}"\n`;
  toml += `localPort = ${parseInt(localPort, 10)}\n`;

  if (type === 'http' || type === 'https') {
    const fullDomain = subdomain ? `${subdomain}.${domain}` : domain;
    toml += `customDomains = ["${fullDomain}"]\n`;
  } else if (type === 'tcp' || type === 'udp') {
    if (remotePort) toml += `remotePort = ${parseInt(remotePort, 10)}\n`;
  }

  res.setHeader('Content-Type', 'application/toml');
  res.setHeader('Content-Disposition', `attachment; filename="frpc-${name}.toml"`);
  res.send(toml);
});

// Reload frpc
function reloadFrpc() {
  try {
    execSync('frpc reload -c ' + FRPC_MAIN, { timeout: 5000 });
    console.log('[frpc] reload 成功');
  } catch (err) {
    console.error('[frpc] reload 失敗:', err.message);
  }
}

// --- 前端頁面 ---
app.get('/', (_req, res) => {
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FRP Panel — Digitalent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f0f2f5; color: #333; }
  .container { max-width: 800px; margin: 0 auto; padding: 20px; }
  h1 { text-align: center; margin: 20px 0; color: #1a73e8; }
  .card { background: #fff; border-radius: 8px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .card h2 { margin-bottom: 16px; font-size: 18px; color: #555; }
  label { display: block; margin-bottom: 4px; font-weight: 500; font-size: 14px; }
  input, select { width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 12px; font-size: 14px; }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; }
  button { padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
  .btn-primary { background: #1a73e8; color: #fff; }
  .btn-primary:hover { background: #1557b0; }
  .btn-danger { background: #ea4335; color: #fff; }
  .btn-danger:hover { background: #c5221f; }
  .btn-secondary { background: #34a853; color: #fff; }
  .btn-secondary:hover { background: #2d8e47; }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  th { color: #666; font-weight: 500; }
  .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 4px; color: #fff; font-size: 14px; z-index: 999; display: none; }
  .toast.ok { background: #34a853; }
  .toast.err { background: #ea4335; }
  #login-screen { display: flex; align-items: center; justify-content: center; min-height: 80vh; }
  #login-screen .card { width: 340px; }
  #app { display: none; }
  .domain-preview { background: #e8f0fe; padding: 6px 12px; border-radius: 4px; margin-bottom: 12px; font-size: 14px; color: #1a73e8; }
  .hidden { display: none; }
</style>
</head>
<body>

<div id="toast" class="toast"></div>

<!-- 登入畫面 -->
<div id="login-screen">
  <div class="card">
    <h2>FRP Panel 登入</h2>
    <label>密碼</label>
    <input type="password" id="login-pw" placeholder="請輸入管理密碼" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="btn-primary" onclick="doLogin()" style="width:100%">登入</button>
  </div>
</div>

<!-- 主畫面 -->
<div id="app" class="container">
  <h1>FRP Panel</h1>

  <!-- 新增隧道 -->
  <div class="card">
    <h2>新增隧道</h2>
    <div class="row">
      <div>
        <label>Proxy 名稱</label>
        <input id="f-name" placeholder="my-web (英數、底線、連字號)">
      </div>
      <div>
        <label>類型</label>
        <select id="f-type" onchange="onTypeChange()">
          <option value="http">HTTP</option>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
      </div>
    </div>

    <!-- HTTP 欄位 -->
    <div id="http-fields">
      <div class="row">
        <div>
          <label>域名</label>
          <select id="f-domain"></select>
        </div>
        <div>
          <label>子域名（選填）</label>
          <input id="f-subdomain" placeholder="app" oninput="updatePreview()">
        </div>
      </div>
      <div class="domain-preview" id="domain-preview">--</div>
    </div>

    <!-- TCP/UDP 欄位 -->
    <div id="tcp-fields" class="hidden">
      <label>遠端 Port（frps 上對外的 port）</label>
      <input id="f-remote-port" type="number" placeholder="6000">
    </div>

    <div class="row">
      <div>
        <label>本地 IP</label>
        <input id="f-local-ip" value="127.0.0.1">
      </div>
      <div>
        <label>本地 Port</label>
        <input id="f-local-port" type="number" placeholder="3000">
      </div>
    </div>

    <div class="actions">
      <button class="btn-primary" onclick="addProxy('local')">加到本機 frpc</button>
      <button class="btn-secondary" onclick="addProxy('download')">下載 frpc.toml（遠端用）</button>
    </div>
  </div>

  <!-- 現有隧道列表 -->
  <div class="card">
    <h2>現有本機隧道</h2>
    <table>
      <thead><tr><th>名稱</th><th>設定</th><th>操作</th></tr></thead>
      <tbody id="proxy-list"></tbody>
    </table>
  </div>
</div>

<script>
// --- 登入 ---
async function doLogin() {
  const pw = document.getElementById('login-pw').value;
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw })
  });
  if (r.ok) {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadDomains();
    loadProxies();
  } else {
    toast('密碼錯誤', true);
  }
}

// --- 載入域名 ---
async function loadDomains() {
  const r = await fetch('/api/domains');
  const domains = await r.json();
  const sel = document.getElementById('f-domain');
  sel.innerHTML = domains.map(d => '<option value="' + d + '">' + d + '</option>').join('');
  sel.addEventListener('change', updatePreview);
  updatePreview();
}

function updatePreview() {
  const domain = document.getElementById('f-domain').value;
  const sub = document.getElementById('f-subdomain').value.trim();
  const full = sub ? sub + '.' + domain : domain;
  document.getElementById('domain-preview').textContent = full;
}

function onTypeChange() {
  const t = document.getElementById('f-type').value;
  document.getElementById('http-fields').classList.toggle('hidden', t !== 'http');
  document.getElementById('tcp-fields').classList.toggle('hidden', t === 'http');
}

// --- 新增 proxy ---
async function addProxy(mode) {
  const data = {
    name: document.getElementById('f-name').value.trim(),
    type: document.getElementById('f-type').value,
    localIP: document.getElementById('f-local-ip').value.trim(),
    localPort: document.getElementById('f-local-port').value,
    domain: document.getElementById('f-domain').value,
    subdomain: document.getElementById('f-subdomain').value.trim(),
    remotePort: document.getElementById('f-remote-port').value,
  };
  if (!data.name || !data.localPort) return toast('請填寫名稱和本地 Port', true);

  if (mode === 'download') {
    // 下載模式：用隱藏 form submit
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/generate';
    for (const [k, v] of Object.entries(data)) {
      const inp = document.createElement('input');
      inp.type = 'hidden'; inp.name = k; inp.value = v;
      form.appendChild(inp);
    }
    document.body.appendChild(form);
    form.submit();
    form.remove();
    return;
  }

  const r = await fetch('/api/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const result = await r.json();
  if (r.ok) {
    toast('隧道已新增並 reload');
    loadProxies();
    document.getElementById('f-name').value = '';
    document.getElementById('f-subdomain').value = '';
    document.getElementById('f-local-port').value = '';
  } else {
    toast(result.error, true);
  }
}

// --- 列出 proxy ---
async function loadProxies() {
  const r = await fetch('/api/proxies');
  const proxies = await r.json();
  const tbody = document.getElementById('proxy-list');
  if (proxies.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#999">尚無隧道</td></tr>';
    return;
  }
  tbody.innerHTML = proxies.map(p => {
    const name = p.filename.replace('.toml', '');
    const summary = p.content.replace(/\\n/g, ' ').substring(0, 80);
    return '<tr><td><strong>' + name + '</strong></td>'
      + '<td><code style="font-size:12px;white-space:pre-wrap">' + escHtml(p.content.trim()) + '</code></td>'
      + '<td><button class="btn-danger" onclick="delProxy(\\''+p.filename+'\\')">刪除</button></td></tr>';
  }).join('');
}

async function delProxy(filename) {
  if (!confirm('確定要刪除 ' + filename + '？')) return;
  const r = await fetch('/api/proxies/' + encodeURIComponent(filename), { method: 'DELETE' });
  if (r.ok) { toast('已刪除'); loadProxies(); }
  else toast('刪除失敗', true);
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (isErr ? 'err' : 'ok');
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`FRP Panel 啟動於 http://localhost:${PORT}`);
});
