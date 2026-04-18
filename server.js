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

// frps Admin API
const FRPS_ADMIN_URL = process.env.FRPS_ADMIN_URL || 'https://127.0.0.1:7500';
const FRPS_ADMIN_USER = process.env.FRPS_ADMIN_USER || 'admin';
const FRPS_ADMIN_PASS = process.env.FRPS_ADMIN_PASS || '';

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

// --- Helper: 查詢 frps Admin API ---
async function fetchFrpsApi(endpoint) {
  const url = `${FRPS_ADMIN_URL}${endpoint}`;
  const auth = Buffer.from(`${FRPS_ADMIN_USER}:${FRPS_ADMIN_PASS}`).toString('base64');
  const res = await fetch(url, {
    headers: { 'Authorization': `Basic ${auth}` },
    // frps 可能使用自簽憑證
    ...(url.startsWith('https') ? { dispatcher: undefined } : {}),
  });
  if (!res.ok) throw new Error(`frps API ${endpoint} returned ${res.status}`);
  return res.json();
}

// --- API ---

// 取得可用域名列表
app.get('/api/domains', (_req, res) => {
  res.json(DOMAINS);
});

// 取得 frps 上所有 proxy（從 Admin API）
app.get('/api/all-proxies', async (_req, res) => {
  try {
    const [httpData, tcpData, udpData] = await Promise.all([
      fetchFrpsApi('/api/proxy/http').catch(() => ({ proxies: [] })),
      fetchFrpsApi('/api/proxy/tcp').catch(() => ({ proxies: [] })),
      fetchFrpsApi('/api/proxy/udp').catch(() => ({ proxies: [] })),
    ]);
    const proxies = [
      ...(httpData.proxies || []).map(p => ({ ...p, _type: 'http' })),
      ...(tcpData.proxies || []).map(p => ({ ...p, _type: 'tcp' })),
      ...(udpData.proxies || []).map(p => ({ ...p, _type: 'udp' })),
    ];
    res.json(proxies);
  } catch (err) {
    console.error('[frps API] 查詢失敗:', err.message);
    res.status(502).json({ error: '無法連線 frps Admin API' });
  }
});

// 列出本面板管理的 proxy（conf.d/）
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
  if ((type === 'tcp' || type === 'udp') && remotePort) {
    const p = parseInt(remotePort, 10);
    if (p < 60000 || p > 62999) {
      return res.status(400).json({ error: '遠端 Port 必須在 60000–62999 範圍內' });
    }
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
    const fullDomain = subdomain ? `${subdomain}.${domain}` : (domain || DOMAINS[0]);
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
    const fullDomain = subdomain ? `${subdomain}.${domain}` : (domain || DOMAINS[0]);
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
  .container { max-width: 960px; margin: 0 auto; padding: 20px; }
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
  .btn-danger { background: #ea4335; color: #fff; font-size: 12px; padding: 6px 12px; }
  .btn-danger:hover { background: #c5221f; }
  .btn-secondary { background: #34a853; color: #fff; }
  .btn-secondary:hover { background: #2d8e47; }
  .actions { display: flex; gap: 8px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 13px; }
  th { color: #666; font-weight: 500; background: #fafafa; }
  .toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 4px; color: #fff; font-size: 14px; z-index: 999; display: none; }
  .toast.ok { background: #34a853; }
  .toast.err { background: #ea4335; }
  #login-screen { display: flex; align-items: center; justify-content: center; min-height: 80vh; }
  #login-screen .card { width: 340px; }
  #app { display: none; }
  .domain-preview { background: #e8f0fe; padding: 6px 12px; border-radius: 4px; margin-bottom: 12px; font-size: 14px; color: #1a73e8; }
  .port-info { background: #fff4e5; border-left: 3px solid #ff9800; padding: 10px 14px; border-radius: 4px; margin-bottom: 16px; font-size: 13px; color: #555; }
  .port-hint { font-size: 12px; color: #ff9800; margin-top: -8px; margin-bottom: 12px; }
  .hidden { display: none; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge-online { background: #e6f4ea; color: #1e8e3e; }
  .badge-offline { background: #fce8e6; color: #c5221f; }
  .badge-http { background: #e8f0fe; color: #1a73e8; }
  .badge-tcp { background: #fef7e0; color: #b06000; }
  .badge-udp { background: #f3e8fd; color: #7627bb; }
  .traffic { font-size: 11px; color: #888; }
  .subdomain-link { color: #1a73e8; text-decoration: none; }
  .subdomain-link:hover { text-decoration: underline; }
  .tab-bar { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid #eee; }
  .tab-bar button { background: none; border: none; padding: 10px 20px; font-size: 14px; font-weight: 500; color: #666; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; }
  .tab-bar button.active { color: #1a73e8; border-bottom-color: #1a73e8; }
  .stats { display: flex; gap: 16px; margin-bottom: 16px; }
  .stat-box { background: #f8f9fa; border-radius: 8px; padding: 12px 16px; flex: 1; text-align: center; }
  .stat-box .num { font-size: 24px; font-weight: 700; color: #1a73e8; }
  .stat-box .label { font-size: 12px; color: #888; }
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

  <!-- 統計 -->
  <div class="stats">
    <div class="stat-box"><div class="num" id="stat-total">-</div><div class="label">全部隧道</div></div>
    <div class="stat-box"><div class="num" id="stat-online">-</div><div class="label">上線中</div></div>
    <div class="stat-box"><div class="num" id="stat-offline">-</div><div class="label">離線</div></div>
  </div>

  <!-- Tab 切換 -->
  <div class="tab-bar">
    <button class="active" onclick="switchTab('all', this)">所有隧道</button>
    <button onclick="switchTab('managed', this)">本面板管理</button>
    <button onclick="switchTab('add', this)">新增隧道</button>
  </div>

  <!-- 所有隧道 -->
  <div id="tab-all" class="card">
    <h2>frps 上所有註冊的隧道</h2>
    <div class="port-info">🔌 TCP/UDP 可使用 Port 範圍：<strong>60000 – 62999</strong>（已開放 iptables，專供 frp 隧道使用）</div>
    <table>
      <thead><tr><th>名稱</th><th>類型</th><th>域名 / Port</th><th>狀態</th><th>今日流量</th><th>連線</th></tr></thead>
      <tbody id="all-proxy-list"></tbody>
    </table>
  </div>

  <!-- 本面板管理 -->
  <div id="tab-managed" class="card" style="display:none">
    <h2>由本面板管理的隧道（conf.d/）</h2>
    <table>
      <thead><tr><th>名稱</th><th>設定</th><th>操作</th></tr></thead>
      <tbody id="proxy-list"></tbody>
    </table>
  </div>

  <!-- 新增隧道 -->
  <div id="tab-add" class="card" style="display:none">
    <h2>新增隧道</h2>
    <div class="port-info">🔌 TCP/UDP 可使用 Port 範圍：<strong>60000 – 62999</strong>（已開放 iptables，專供 frp 隧道使用）</div>
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
      <input id="f-remote-port" type="number" placeholder="60000" min="60000" max="62999">
      <div class="port-hint">💡 可使用範圍：<strong>60000 – 62999</strong>（其他 port 未開放 iptables）</div>
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
    loadAllProxies();
    loadProxies();
  } else {
    toast('密碼錯誤', true);
  }
}

// --- Tab 切換 ---
function switchTab(name, btn) {
  document.querySelectorAll('.tab-bar button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  ['all', 'managed', 'add'].forEach(t => {
    document.getElementById('tab-' + t).style.display = t === name ? '' : 'none';
  });
  if (name === 'all') loadAllProxies();
  if (name === 'managed') loadProxies();
}

// --- 格式化流量 ---
function fmtBytes(b) {
  if (!b || b === 0) return '-';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

// --- 載入所有 proxy（frps API）---
async function loadAllProxies() {
  try {
    const r = await fetch('/api/all-proxies');
    const proxies = await r.json();

    // 統計
    const online = proxies.filter(p => p.status === 'online').length;
    document.getElementById('stat-total').textContent = proxies.length;
    document.getElementById('stat-online').textContent = online;
    document.getElementById('stat-offline').textContent = proxies.length - online;

    // 排序：online 優先，再依名稱
    proxies.sort((a, b) => {
      if (a.status === 'online' && b.status !== 'online') return -1;
      if (a.status !== 'online' && b.status === 'online') return 1;
      return a.name.localeCompare(b.name);
    });

    const tbody = document.getElementById('all-proxy-list');
    if (proxies.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999">無法取得 frps 資料</td></tr>';
      return;
    }
    tbody.innerHTML = proxies.map(p => {
      const typeBadge = '<span class="badge badge-' + p._type + '">' + p._type.toUpperCase() + '</span>';
      const statusBadge = '<span class="badge badge-' + p.status + '">' + (p.status === 'online' ? '上線' : '離線') + '</span>';

      let target = '-';
      if (p._type === 'http') {
        const sub = p.conf?.subdomain;
        const custom = p.conf?.customDomains;
        if (sub) {
          const domain = sub + '.' + (DOMAINS[0] || 'example.com');
          target = '<a class="subdomain-link" href="https://' + domain + '" target="_blank">' + domain + '</a>';
        } else if (custom && custom.length) {
          target = escHtml(custom.join(', '));
        }
      } else if (p._type === 'tcp' || p._type === 'udp') {
        const rp = p.conf?.remotePort;
        if (rp) target = ':' + rp;
      }

      const trafficIn = fmtBytes(p.todayTrafficIn);
      const trafficOut = fmtBytes(p.todayTrafficOut);
      const traffic = '<span class="traffic">&uarr;' + trafficOut + ' &darr;' + trafficIn + '</span>';

      return '<tr>'
        + '<td><strong>' + escHtml(p.name) + '</strong></td>'
        + '<td>' + typeBadge + '</td>'
        + '<td>' + target + '</td>'
        + '<td>' + statusBadge + '</td>'
        + '<td>' + traffic + '</td>'
        + '<td>' + (p.curConns || 0) + '</td>'
        + '</tr>';
    }).join('');
  } catch (err) {
    console.error('loadAllProxies error:', err);
    document.getElementById('all-proxy-list').innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:#c5221f">frps Admin API 連線失敗</td></tr>';
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
    loadAllProxies();
    document.getElementById('f-name').value = '';
    document.getElementById('f-subdomain').value = '';
    document.getElementById('f-local-port').value = '';
  } else {
    toast(result.error, true);
  }
}

// --- 列出本面板管理的 proxy ---
async function loadProxies() {
  const r = await fetch('/api/proxies');
  const proxies = await r.json();
  const tbody = document.getElementById('proxy-list');
  if (proxies.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:#999">尚無由本面板管理的隧道</td></tr>';
    return;
  }
  tbody.innerHTML = proxies.map(p => {
    const name = p.filename.replace('.toml', '');
    return '<tr><td><strong>' + escHtml(name) + '</strong></td>'
      + '<td><code style="font-size:12px;white-space:pre-wrap">' + escHtml(p.content.trim()) + '</code></td>'
      + '<td><button class="btn-danger" onclick="delProxy(\\'' + p.filename + '\\')">刪除</button></td></tr>';
  }).join('');
}

async function delProxy(filename) {
  if (!confirm('確定要刪除 ' + filename + '？')) return;
  const r = await fetch('/api/proxies/' + encodeURIComponent(filename), { method: 'DELETE' });
  if (r.ok) { toast('已刪除'); loadProxies(); loadAllProxies(); }
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
  console.log('FRP Panel 啟動於 http://localhost:' + PORT);
});
