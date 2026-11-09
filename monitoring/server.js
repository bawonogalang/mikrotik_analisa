// Web monitoring client WiFi MikroTik lewat REST API (RouterOS 7).
// Jalankan:  node server.js          -> konek ke router sesuai .env
//            node server.js --demo   -> data contoh, tanpa router
//
// Kalau SSH_HOST + SSH_KEY diisi di .env, server membuka tunnel SSH sendiri
// dan menyambung ulang otomatis kalau putus. Riwayat per menit disimpan di
// folder data/ untuk analisa (lambat, putus, IP DHCP habis, dll).
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DEMO = process.argv.includes('--demo');
const env = loadEnv(path.join(__dirname, '.env'));
const cfg = {
  url: (env.MT_URL || 'http://127.0.0.1:18080').replace(/\/+$/, ''),
  user: env.MT_USER || 'webmon',
  pass: env.MT_PASS || '',
  lanPrefix: env.LAN_PREFIX || '172.19.26.',
  wanIf: env.WAN_IF || 'ether1_INTERNET',
  lanIf: env.LAN_IF || 'ether4',
  port: Number(process.env.PORT || env.PORT || 8090),
  // 127.0.0.1 = hanya PC ini; 0.0.0.0 = bisa dibuka dari PC lain di jaringan lokal
  listenHost: env.LISTEN_HOST || '127.0.0.1',
  pollMs: Math.max(1000, Number(env.POLL_MS || 3000)),
  healthMs: Math.max(10000, Number(env.HEALTH_MS || 30000)),
  keepDays: Math.max(7, Number(env.KEEP_DAYS || 90)),
  dataDir: path.join(__dirname, DEMO ? 'data-demo' : 'data'),
  logDir: path.join(__dirname, 'logs'),
  ssh: {
    host: env.SSH_HOST || '',
    port: env.SSH_PORT || '22',
    user: env.SSH_USER || env.MT_USER || 'webmon',
    key: env.SSH_KEY || '',
    target: env.TUNNEL_TARGET || '172.19.26.1:80',
  },
  // "Label=alamat,Label=alamat"; target pertama dianggap patokan internet
  pingTargets: (env.PING_TARGETS || 'Internet=8.8.8.8,BAKUDAPA=bakudapa.malutprov.go.id')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s, i) => {
      const [label, address] = s.includes('=') ? s.split('=') : [s, s];
      return { key: i === 0 ? 'inet' : address.trim(), role: i === 0 ? 'inet' : 'site', label: label.trim(), address: address.trim() };
    }),
};
const HISTORY_LEN = 120;
const MEM_DAYS = 8; // hari riwayat per menit yang disimpan di memori

// connection-mark dari script QoS -> kelas prioritas
const CLASS_OF_MARK = {
  'qos26-top': 'top',
  'qos26-office': 'office',
  'qos26-normal': 'normal',
  'qos26-bulk': 'bulk',
};
const CLASS_KEYS = ['top', 'office', 'normal', 'bulk', 'other'];
const QUEUE_CLASS = ['top', 'office', 'normal', 'bulk']; // QOS26-D1..D4 / U1..U4

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// RouterOS mengirim angka sebagai string, kadang dengan satuan ("40M", "12.5kbps")
function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const m = String(v).trim().match(/^(-?[\d.]+)\s*([kmgt]?)/i);
  if (!m) return 0;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2].toLowerCase()];
  return parseFloat(m[1]) * mult;
}

// Durasi RouterOS ("23ms456us", "1s2ms") -> milidetik
function msOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let ms = 0;
  let hit = false;
  for (const m of String(v).matchAll(/([\d.]+)(ms|us|s)/g)) {
    hit = true;
    ms += parseFloat(m[1]) * { s: 1000, ms: 1, us: 0.001 }[m[2]];
  }
  return hit ? Math.round(ms * 10) / 10 : null;
}

const ipOf = (addr) => String(addr || '').split(':')[0];
const isLan = (ip) => ip.startsWith(cfg.lanPrefix);
const ipNum = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const emptyClasses = () => Object.fromEntries(CLASS_KEYS.map((k) => [k, { down: 0, up: 0 }]));
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// ---- Log ke file (dirotasi 2 MB), pesan sama berturut-turut tidak diulang ----
let lastLogMsg = '';
function log(msg) {
  if (msg === lastLogMsg) return;
  lastLogMsg = msg;
  const line = `${new Date().toLocaleString('id-ID')} ${msg}`;
  console.log(line);
  if (DEMO) return;
  try {
    fs.mkdirSync(cfg.logDir, { recursive: true });
    const f = path.join(cfg.logDir, 'server.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 2e6) fs.renameSync(f, path.join(cfg.logDir, 'server.old.log'));
    fs.appendFileSync(f, line + '\n');
  } catch { /* log tidak boleh menghentikan monitoring */ }
}

async function rest(method, p, body, timeoutMs = 8000) {
  const res = await fetch(cfg.url + '/rest' + p, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res.json();
}
const errText = (e) => `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''}`;

// ---- Tunnel SSH otomatis (pakai SSH key, tanpa password) ----
const tunnel = {
  enabled: !DEMO && !!(cfg.ssh.host && cfg.ssh.key),
  state: 'off', // off | connecting | up | down
  since: Date.now(),
  restarts: 0,
  lastError: '',
};
let sshProc = null;
let sshStarted = 0;
let tunnelDelay = 5000;
let lastRestOk = 0;

// Tunnel sisa dari proses server sebelumnya masih memegang port lokal -> matikan dulu
function killStaleTunnels() {
  if (process.platform !== 'win32') return;
  const keyName = path.basename(cfg.ssh.key).replace(/'/g, "''");
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*${keyName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
    { stdio: 'ignore', windowsHide: true, timeout: 20000 });
  } catch { /* tidak ada tunnel lama */ }
}

function startTunnel() {
  const localPort = new URL(cfg.url).port || '80';
  const args = ['-N', '-T', '-i', cfg.ssh.key, '-p', cfg.ssh.port,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=20',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-L', `127.0.0.1:${localPort}:${cfg.ssh.target}`, `${cfg.ssh.user}@${cfg.ssh.host}`];
  tunnel.state = 'connecting';
  tunnel.since = Date.now();
  sshStarted = Date.now();
  const p = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  sshProc = p;
  let ended = false;
  const onEnd = (code) => {
    if (ended) return;
    ended = true;
    sshProc = null;
    tunnel.state = 'down';
    tunnel.since = Date.now();
    tunnel.restarts++;
    // Putus setelah lama tersambung -> coba lagi cepat; gagal terus -> jeda makin panjang
    tunnelDelay = Date.now() - sshStarted > 120000 ? 5000 : Math.min(tunnelDelay * 2, 60000);
    log(`Tunnel SSH putus (kode ${code})${tunnel.lastError ? ': ' + tunnel.lastError : ''}. Sambung ulang dalam ${tunnelDelay / 1000} detik.`);
    setTimeout(startTunnel, tunnelDelay);
  };
  p.stderr.on('data', (d) => {
    const t = String(d).trim();
    if (t) tunnel.lastError = t.split(/\r?\n/).pop().slice(0, 300);
  });
  p.on('error', (e) => { tunnel.lastError = e.message; onEnd(e.code); });
  p.on('exit', (code) => onEnd(code));
}

function watchTunnel(restOk) {
  if (!tunnel.enabled) return;
  const now = Date.now();
  if (restOk) {
    lastRestOk = now;
    if (tunnel.state === 'connecting') {
      tunnel.state = 'up';
      tunnel.since = now;
      tunnel.lastError = '';
      log('Tunnel SSH tersambung, data router terbaca.');
    }
    return;
  }
  // Proses ssh masih hidup tapi router tidak menjawab -> paksa sambung ulang
  if (sshProc && now - sshStarted > 90000 && now - lastRestOk > 90000) {
    log('Router tidak menjawab lewat tunnel selama 90 detik, tunnel diulang.');
    sshProc.kill();
  }
}

async function fetchRouter() {
  const calls = {
    resource: rest('GET', '/system/resource'),
    identity: rest('GET', '/system/identity'),
    ifaces: rest('GET', '/interface?.proplist=name,rx-byte,tx-byte,running,link-downs'),
    queues: rest('GET', '/queue/tree'),
    leases: rest('GET', '/ip/dhcp-server/lease'),
    arp: rest('GET', '/ip/arp'),
    conns: rest('GET', '/ip/firewall/connection?.proplist=.id,src-address,dst-address,orig-bytes,repl-bytes,orig-rate,repl-rate,connection-mark'),
    filters: rest('GET', '/ip/firewall/filter?.proplist=comment,packets,bytes'),
    adlist: rest('GET', '/ip/dns/adlist'),
    addrs: rest('GET', '/ip/address?.proplist=address'),
  };
  const keys = Object.keys(calls);
  const settled = await Promise.allSettled(Object.values(calls));
  const raw = {};
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') raw[keys[i]] = s.value;
    else {
      raw[keys[i]] = null;
      errors.push(`${keys[i]}: ${errText(s.reason)}`);
    }
  });
  return { raw, errors };
}

// ---- Kesehatan jaringan (tiap 30 detik): ping modem/internet/BAKUDAPA + pool DHCP ----
let health = { time: 0, pings: [], pool: null, errors: [] };

function poolSize(ranges) {
  let size = 0;
  for (const r of String(ranges || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (r.includes('/')) size += 2 ** (32 - Number(r.split('/')[1]));
    else if (r.includes('-')) { const [a, b] = r.split('-'); size += ipNum(b) - ipNum(a) + 1; }
    else size += 1;
  }
  return size;
}

async function fetchHealth() {
  const out = { time: Date.now(), pings: [], pool: null, errors: [] };
  const [routes, pools, servers, used] = await Promise.allSettled([
    rest('GET', '/ip/route?dst-address=0.0.0.0/0'),
    rest('GET', '/ip/pool'),
    rest('GET', '/ip/dhcp-server'),
    rest('GET', '/ip/pool/used'),
  ]);

  const targets = [];
  if (routes.status === 'fulfilled') {
    const gw = routes.value.find((r) => r.active === 'true' && /^\d+\.\d+\.\d+\.\d+$/.test(r.gateway || ''));
    if (gw) targets.push({ key: 'gw', role: 'gw', label: 'Modem IndiHome', address: gw.gateway });
  }
  targets.push(...cfg.pingTargets);
  const results = await Promise.allSettled(targets.map((t) => rest('POST', '/ping', { address: t.address, count: '5', interval: '200ms' }, 15000)));
  results.forEach((r, i) => {
    const t = targets[i];
    if (r.status === 'fulfilled') {
      const rows = Array.isArray(r.value) ? r.value : [];
      const last = rows[rows.length - 1] || {};
      const sent = num(last.sent) || rows.length;
      const recv = last.received != null ? num(last.received) : rows.filter((x) => x.time).length;
      const loss = last['packet-loss'] != null ? num(last['packet-loss']) : (sent ? Math.round((1 - recv / sent) * 100) : 100);
      out.pings.push({ ...t, rtt: recv ? msOf(last['avg-rtt']) : null, max: recv ? msOf(last['max-rtt']) : null, loss });
    } else {
      out.pings.push({ ...t, rtt: null, max: null, loss: null, error: errText(r.reason) });
      out.errors.push(`ping ${t.label}: ${errText(r.reason)}`);
    }
  });

  if (pools.status === 'fulfilled') {
    const pool = pools.value.find((p) => String(p.ranges || '').split(',').some((r) => r.trim().startsWith(cfg.lanPrefix)));
    if (pool) {
      const srv = servers.status === 'fulfilled' ? servers.value.find((s) => s['address-pool'] === pool.name) : null;
      const size = pool.total != null ? num(pool.total) : poolSize(pool.ranges);
      let inUse = pool.used != null ? num(pool.used) : null;
      if (inUse == null && used.status === 'fulfilled') inUse = used.value.filter((u) => u.pool === pool.name).length;
      out.pool = { name: pool.name, size, used: inUse, leaseTime: (srv && srv['lease-time']) || '', server: (srv && srv.name) || '' };
    }
  } else {
    out.errors.push(`pool DHCP: ${errText(pools.reason)}`);
  }
  return out;
}

// ---- Olah data mentah router menjadi snapshot untuk halaman web ----
let prev = null; // penghitung byte dari polling sebelumnya, untuk hitung kecepatan
const history = [];

function build(raw, now, errors) {
  // Setelah lama terputus, penghitung lama tidak dipakai (kecepatan jadi rata-rata palsu)
  if (prev && now - prev.t > cfg.pollMs * 5) prev = null;
  const dt = prev ? (now - prev.t) / 1000 : 0;
  const rate = (cur, old) => (dt > 0 && old != null && cur >= old ? ((cur - old) * 8) / dt : 0);
  const next = { t: now, ifaces: {}, conns: new Map(), queues: new Map() };

  // Trafik interface: WAN rx = download, LAN tx = download ke client
  const wan = { down: 0, up: 0, linkDowns: null, running: null };
  const lan = { down: 0, up: 0, linkDowns: null, running: null };
  for (const i of raw.ifaces || []) {
    const rx = num(i['rx-byte']);
    const tx = num(i['tx-byte']);
    next.ifaces[i.name] = { rx, tx };
    const old = prev && prev.ifaces[i.name];
    if (i.name === cfg.wanIf) {
      wan.down = rate(rx, old && old.rx);
      wan.up = rate(tx, old && old.tx);
      wan.linkDowns = num(i['link-downs']);
      wan.running = i.running === 'true';
    }
    if (i.name === cfg.lanIf) {
      lan.down = rate(tx, old && old.tx);
      lan.up = rate(rx, old && old.rx);
      lan.linkDowns = num(i['link-downs']);
      lan.running = i.running === 'true';
    }
  }

  // Client dari DHCP lease + ARP + koneksi aktif (IP milik router sendiri tidak dihitung)
  const routerIps = new Set((raw.addrs || []).map((a) => String(a.address || '').split('/')[0]));
  const clients = new Map();
  const client = (ip) => {
    if (!clients.has(ip)) {
      clients.set(ip, {
        ip, mac: '', host: '', comment: '', online: false, lease: '', lastSeen: '',
        down: 0, up: 0, conns: 0, sessDown: 0, sessUp: 0, classes: emptyClasses(),
      });
    }
    return clients.get(ip);
  };
  for (const l of raw.leases || []) {
    const ip = l['active-address'] || l.address || '';
    if (!isLan(ip)) continue;
    const c = client(ip);
    c.mac = l['active-mac-address'] || l['mac-address'] || c.mac;
    c.host = l['host-name'] || '';
    c.comment = l.comment || '';
    c.lease = l.status || '';
    c.lastSeen = l['last-seen'] || '';
  }
  for (const a of raw.arp || []) {
    const ip = a.address || '';
    if (!isLan(ip)) continue;
    const c = client(ip);
    c.mac = c.mac || a['mac-address'] || '';
    if (a['mac-address'] && !/failed|incomplete/i.test(a.status || '')) c.online = true;
  }

  const firstPoll = !prev;
  for (const k of raw.conns || []) {
    const src = ipOf(k['src-address']);
    const dst = ipOf(k['dst-address']);
    const outbound = isLan(src);
    if (!outbound && !isLan(dst)) continue;
    if (routerIps.has(outbound ? src : dst)) continue;
    const ob = num(k['orig-bytes']);
    const rb = num(k['repl-bytes']);
    next.conns.set(k['.id'], { ob, rb });

    let origRate;
    let replRate;
    const old = prev && prev.conns.get(k['.id']);
    if (firstPoll) {
      origRate = num(k['orig-rate']);
      replRate = num(k['repl-rate']);
    } else if (old) {
      origRate = rate(ob, old.ob);
      replRate = rate(rb, old.rb);
    } else {
      // koneksi baru sejak polling terakhir
      origRate = (ob * 8) / dt;
      replRate = (rb * 8) / dt;
    }

    const c = client(outbound ? src : dst);
    const up = outbound ? origRate : replRate;
    const down = outbound ? replRate : origRate;
    const cls = CLASS_OF_MARK[k['connection-mark']] || 'other';
    c.conns++;
    c.down += down;
    c.up += up;
    c.sessDown += outbound ? rb : ob;
    c.sessUp += outbound ? ob : rb;
    c.classes[cls].down += down;
    c.classes[cls].up += up;
    if (down > 0 || up > 0) c.online = true;
  }

  // Queue tree QoS
  const qos = Object.fromEntries(QUEUE_CLASS.map((k) => [k, { down: 0, up: 0, dropped: 0, devices: 0 }]));
  const limits = { down: 0, up: 0 };
  for (const q of raw.queues || []) {
    const name = q.name || '';
    if (!name.startsWith('QOS26-')) continue;
    const bytes = num(q.bytes);
    next.queues.set(name, bytes);
    if (name === 'QOS26-DOWNLOAD') { limits.down = num(q['max-limit']); continue; }
    if (name === 'QOS26-UPLOAD') { limits.up = num(q['max-limit']); continue; }
    const m = name.match(/^QOS26-([DU])(\d)/);
    const key = m && QUEUE_CLASS[Number(m[2]) - 1];
    if (!key) continue;
    const r = q.rate !== undefined ? num(q.rate) : rate(bytes, prev && prev.queues.get(name));
    if (m[1] === 'D') {
      qos[key].down = r;
      qos[key].dropped = num(q.dropped);
      qos[key].devices = num(q['pcq-queues']);
    } else {
      qos[key].up = r;
    }
  }

  // Statistik blokir judi / game (rule firewall BLOK-26 + blocklist DNS)
  const blocked = { judi: 0, game: 0, bypass: 0, dnsBlocklist: 0, installed: false, rules: [] };
  for (const f of raw.filters || []) {
    const cm = f.comment || '';
    if (!cm.startsWith('BLOK-26')) continue;
    blocked.installed = true;
    const cat = / judi /.test(cm + ' ') ? 'judi'
      : / game /.test(cm + ' ') ? 'game'
      : /DoH|DoT|DoQ/.test(cm) ? 'bypass' : null;
    if (!cat) continue;
    const packets = num(f.packets);
    blocked[cat] += packets;
    if (packets > 0) blocked.rules.push({ name: cm.replace(/^BLOK-26\s*/, ''), cat, packets });
  }
  blocked.rules.sort((a, b) => b.packets - a.packets);
  blocked.rules = blocked.rules.slice(0, 8);
  for (const a of raw.adlist || []) blocked.dnsBlocklist += num(a['match-count']);

  const r = raw.resource || {};
  const router = {
    name: (raw.identity && raw.identity.name) || '',
    version: r.version || '',
    board: r['board-name'] || '',
    uptime: r.uptime || '',
    cpu: num(r['cpu-load']),
    memTotal: num(r['total-memory']),
    memUsed: num(r['total-memory']) - num(r['free-memory']),
  };

  // Simpan penghitung; kalau satu bagian gagal, pakai penghitung lama
  if (prev) {
    if (!raw.ifaces) next.ifaces = prev.ifaces;
    if (!raw.conns) next.conns = prev.conns;
    if (!raw.queues) next.queues = prev.queues;
  }
  if (raw.ifaces && dt > 0) {
    history.push({ t: now, down: wan.down, up: wan.up });
    if (history.length > HISTORY_LEN) history.shift();
  }
  prev = next;

  return {
    ok: errors.length < Object.keys(raw).length,
    rated: dt > 0 && !!raw.ifaces,
    dt,
    demo: DEMO,
    time: now,
    pollMs: cfg.pollMs,
    lanPrefix: cfg.lanPrefix,
    lanIf: cfg.lanIf,
    errors,
    router,
    wan,
    lan,
    limits,
    qos,
    clients: [...clients.values()],
    blocked,
    history: history.slice(),
  };
}

// ---- Riwayat per menit: data/YYYY-MM-DD.jsonl (dihapus otomatis setelah KEEP_DAYS) ----
const minutes = [];
let acc = null;
let lastCounters = { drops: null, lanDowns: null, wanDowns: null };
let firstT = null;

function newAcc(t) {
  return { t, n: 0, ok: 0, down: 0, downMax: 0, up: 0, upMax: 0, cpu: 0, online: 0, conns: 0, lim: 0, limUp: 0, drops: null, lanDowns: null, wanDowns: null };
}

function track(s) {
  const t = Math.floor(s.time / 60000) * 60000;
  if (acc && acc.t !== t) flushMinute();
  if (!acc) acc = newAcc(t);
  acc.n++;
  if (!s.ok || !s.rated) return;
  acc.ok++;
  acc.down += s.wan.down;
  acc.up += s.wan.up;
  acc.downMax = Math.max(acc.downMax, s.wan.down);
  acc.upMax = Math.max(acc.upMax, s.wan.up);
  acc.cpu = Math.max(acc.cpu, s.router.cpu);
  acc.online = Math.max(acc.online, s.clients.filter((c) => c.online).length);
  acc.conns = Math.max(acc.conns, s.clients.reduce((a, c) => a + c.conns, 0));
  acc.lim = s.limits.down;
  acc.limUp = s.limits.up;
  acc.drops = Object.fromEntries(QUEUE_CLASS.map((k) => [k, s.qos[k].dropped]));
  acc.lanDowns = s.lan.linkDowns;
  acc.wanDowns = s.wan.linkDowns;
}

// Selisih penghitung kumulatif; kalau router reboot (penghitung reset) pakai nilai baru
const delta = (cur, old) => (cur == null || old == null ? 0 : cur >= old ? cur - old : cur);

function flushMinute() {
  const a = acc;
  acc = null;
  const rec = { t: a.t, n: a.n, ok: a.ok };
  if (a.ok) {
    Object.assign(rec, {
      down: Math.round(a.down / a.ok), downMax: Math.round(a.downMax),
      up: Math.round(a.up / a.ok), upMax: Math.round(a.upMax),
      cpu: a.cpu, online: a.online, conns: a.conns, lim: a.lim, limUp: a.limUp,
    });
    rec.drop = Object.fromEntries(QUEUE_CLASS.map((k) => [k, delta(a.drops[k], lastCounters.drops && lastCounters.drops[k])]));
    rec.lanDowns = delta(a.lanDowns, lastCounters.lanDowns);
    rec.wanDowns = delta(a.wanDowns, lastCounters.wanDowns);
    lastCounters = { drops: a.drops, lanDowns: a.lanDowns, wanDowns: a.wanDowns };
    if (Date.now() - health.time < cfg.healthMs * 3) {
      rec.ping = Object.fromEntries(health.pings.map((p) => [p.key, { rtt: p.rtt, loss: p.loss }]));
      if (health.pool) rec.pool = { used: health.pool.used, size: health.pool.size };
    }
  } else if (tunnel.enabled && tunnel.state !== 'up') {
    rec.tunnel = tunnel.state;
  }
  minutes.push(rec);
  if (firstT == null) firstT = rec.t;
  const cutoff = Date.now() - MEM_DAYS * 864e5;
  while (minutes.length && minutes[0].t < cutoff) minutes.shift();
  if (!DEMO) {
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.appendFileSync(path.join(cfg.dataDir, dayOf(rec.t) + '.jsonl'), JSON.stringify(rec) + '\n');
    } catch (e) { log('Gagal menyimpan riwayat: ' + e.message); }
  }
  saveUsage();
}

function loadHistory() {
  if (DEMO) return;
  let files = [];
  try { files = fs.readdirSync(cfg.dataDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return; }
  // hapus riwayat yang lebih tua dari KEEP_DAYS
  const oldest = dayOf(Date.now() - cfg.keepDays * 864e5);
  for (const f of files.filter((x) => x.slice(0, 10) < oldest)) {
    try { fs.unlinkSync(path.join(cfg.dataDir, f)); } catch { /* biarkan */ }
    try { fs.unlinkSync(path.join(cfg.dataDir, 'usage-' + f.replace('.jsonl', '.json'))); } catch { /* biarkan */ }
  }
  files = files.filter((x) => x.slice(0, 10) >= oldest);
  const memFrom = dayOf(Date.now() - MEM_DAYS * 864e5);
  for (const f of files) {
    const inMem = f.slice(0, 10) >= memFrom;
    if (!inMem && firstT != null) continue;
    for (const line of fs.readFileSync(path.join(cfg.dataDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (firstT == null) firstT = rec.t;
        if (!inMem) break;
        minutes.push(rec);
      } catch { /* baris rusak dilewati */ }
    }
  }
  if (minutes.length) log(`Riwayat dimuat: ${minutes.length} menit dari ${files.length} file.`);
}

// ---- Pemakaian data per perangkat hari ini (untuk "siapa paling boros") ----
let usage = { date: dayOf(Date.now()), clients: {} };
const usageFile = (date) => path.join(cfg.dataDir, `usage-${date}.json`);

function loadUsage() {
  if (DEMO) return;
  try {
    const u = JSON.parse(fs.readFileSync(usageFile(usage.date), 'utf8'));
    if (u.date === usage.date) usage = u;
  } catch { /* belum ada */ }
}
function saveUsage() {
  if (DEMO) return;
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(usageFile(usage.date), JSON.stringify(usage));
  } catch (e) { log('Gagal menyimpan pemakaian: ' + e.message); }
}
function trackUsage(s) {
  const today = dayOf(s.time);
  if (today !== usage.date) {
    saveUsage();
    usage = { date: today, clients: {} };
  }
  if (!s.ok || !s.rated) return;
  for (const c of s.clients) {
    if (!c.down && !c.up) continue;
    const u = usage.clients[c.ip] || (usage.clients[c.ip] = { name: '', mac: '', down: 0, up: 0 });
    u.name = c.comment || c.host || u.name;
    u.mac = c.mac || u.mac;
    u.down += (c.down * s.dt) / 8;
    u.up += (c.up * s.dt) / 8;
  }
}
const topUsage = (n) => Object.entries(usage.clients)
  .map(([ip, u]) => ({ ip, ...u, down: Math.round(u.down), up: Math.round(u.up) }))
  .sort((a, b) => (b.down + b.up) - (a.down + a.up))
  .slice(0, n);

// ---- API riwayat: dirangkum per bucket supaya grafik ringan ----
function aggregate(list) {
  const ok = list.filter((r) => r.ok);
  const vals = (f) => ok.map(f).filter((x) => x != null);
  const avg = (f) => { const v = vals(f); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const max = (f) => { const v = vals(f); return v.length ? Math.max(...v) : null; };
  const sum = (f) => ok.reduce((a, r) => a + (f(r) || 0), 0);
  const p = { t: list[0].t, rec: list.length, off: list.length - ok.length };
  if (!ok.length) return p;
  p.down = avg((r) => r.down);
  p.downMax = max((r) => r.downMax);
  p.up = avg((r) => r.up);
  p.upMax = max((r) => r.upMax);
  p.cpu = max((r) => r.cpu);
  p.online = max((r) => r.online);
  p.lim = max((r) => r.lim);
  p.drop = Object.fromEntries(QUEUE_CLASS.map((k) => [k, sum((r) => r.drop && r.drop[k])]));
  p.lanDowns = sum((r) => r.lanDowns);
  p.wanDowns = sum((r) => r.wanDowns);
  const keys = new Set(ok.flatMap((r) => Object.keys(r.ping || {})));
  p.ping = {};
  for (const k of keys) {
    p.ping[k] = {
      rtt: avg((r) => r.ping && r.ping[k] && r.ping[k].rtt),
      max: max((r) => r.ping && r.ping[k] && r.ping[k].rtt),
      loss: avg((r) => r.ping && r.ping[k] && r.ping[k].loss),
    };
  }
  p.poolUsed = max((r) => r.pool && r.pool.used);
  p.poolSize = max((r) => r.pool && r.pool.size);
  return p;
}

function historyApi(hours) {
  const h = Math.min(24 * 7, Math.max(1, Number(hours) || 24));
  const to = Date.now();
  const from = to - h * 3600e3;
  const recs = minutes.filter((r) => r.t >= from);
  const bucketMin = Math.max(1, Math.ceil((h * 60) / 480));
  const bucketMs = bucketMin * 60000;
  const buckets = new Map();
  for (const r of recs) {
    const b = Math.floor(r.t / bucketMs) * bucketMs;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }
  const points = [...buckets.entries()].map(([b, list]) => ({ ...aggregate(list), t: b }));

  // Ringkasan: router tak terjangkau (PC menyala tapi data gagal) dan PC monitoring mati
  const start = Math.max(from, firstT == null ? to : firstT);
  const expected = Math.max(0, Math.floor((to - start) / 60000));
  const inRange = recs.filter((r) => r.t >= start);
  const outages = [];
  let cur = null;
  for (const r of inRange) {
    if (!r.ok) {
      if (cur && r.t - cur.end <= 60000) cur.end = r.t;
      else { cur = { start: r.t, end: r.t }; outages.push(cur); }
    }
  }
  outages.forEach((o) => { o.minutes = Math.round((o.end - o.start) / 60000) + 1; });
  const gaps = [];
  let last = start - 60000;
  for (const r of inRange.concat([{ t: Math.floor(to / 60000) * 60000 }])) {
    if (r.t - last > 5 * 60000) gaps.push({ start: last + 60000, end: r.t - 60000, minutes: Math.round((r.t - last) / 60000) - 1 });
    last = r.t;
  }
  return {
    from, to, hours: h, bucketMin, firstT,
    points,
    summary: {
      expected,
      recorded: inRange.length,
      offline: inRange.filter((r) => !r.ok).length,
      outages: outages.sort((a, b) => b.minutes - a.minutes),
      gaps: gaps.sort((a, b) => b.minutes - a.minutes),
    },
    pingTargets: (health.pings.length ? health.pings : cfg.pingTargets).map((p) => ({ key: p.key, role: p.role, label: p.label, address: p.address })),
    pool: health.pool,
    usage: topUsage(15),
    usageDate: usage.date,
  };
}

function exportCsv(date) {
  const file = path.join(cfg.dataDir, `${date}.jsonl`);
  const recs = DEMO
    ? minutes.filter((r) => dayOf(r.t) === date)
    : (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  const pingKeys = [...new Set(recs.flatMap((r) => Object.keys(r.ping || {})))];
  const head = ['waktu', 'terhubung', 'download_rata_kbps', 'download_puncak_kbps', 'upload_rata_kbps', 'upload_puncak_kbps',
    'batas_download_kbps', 'cpu_maks_persen', 'perangkat_online', 'koneksi',
    ...pingKeys.flatMap((k) => [`ping_${k}_ms`, `loss_${k}_persen`]),
    'ip_dhcp_terpakai', 'ip_dhcp_total', ...QUEUE_CLASS.map((k) => `paket_ditahan_${k}`), 'link_down_lan', 'link_down_wan'];
  const kb = (v) => (v == null ? '' : Math.round(v / 1000));
  const rows = recs.map((r) => {
    const d = new Date(r.t);
    const cells = [`${dayOf(r.t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, r.ok ? 'ya' : 'tidak'];
    if (!r.ok) return cells.join(';');
    cells.push(kb(r.down), kb(r.downMax), kb(r.up), kb(r.upMax), kb(r.lim), r.cpu, r.online, r.conns);
    for (const k of pingKeys) {
      const p = (r.ping || {})[k] || {};
      cells.push(p.rtt == null ? '' : Math.round(p.rtt), p.loss == null ? '' : Math.round(p.loss));
    }
    cells.push(r.pool ? r.pool.used : '', r.pool ? r.pool.size : '');
    for (const k of QUEUE_CLASS) cells.push(r.drop ? r.drop[k] : '');
    cells.push(r.lanDowns || 0, r.wanDowns || 0);
    return cells.join(';');
  });
  return 'sep=;\r\n' + [head.join(';'), ...rows].join('\r\n') + '\r\n';
}

// ---- Mode demo: data mentah palsu dengan format yang sama seperti REST API ----
function makeDemo() {
  const devices = [
    ['LAPTOP-SEKRETARIAT', 'top'], ['PC-KEUANGAN-01', 'office'], ['android-7f3a2c91', 'bulk'],
    ['iPhone-Kabid', 'office'], ['HP-Resepsionis', 'normal'], ['LAPTOP-PROGRAMER', 'top'],
    ['Redmi-Note-12', 'bulk'], ['Galaxy-A54', 'normal'], ['PC-ARSIP', 'office'],
    ['OPPO-A78', 'bulk'], ['', 'normal'], ['DESKTOP-K2J9QF1', 'office'], ['vivo-Y36', 'normal'],
  ];
  const base = { top: 2.5e6, office: 1.2e6, normal: 1.5e6, bulk: 4e6 };
  const counters = { wanRx: 8e9, wanTx: 1.2e9, lanRx: 1.1e9, lanTx: 7.6e9 };
  const qBytes = {};
  const blk = { 'judi *slot*': 41, 'judi *gacor*': 17, 'game *mobilelegends*': 63, 'game *garena*': 22, 'DoH dns.google': 9 };
  let adlistHits = 12;
  let nextId = 1;
  const conns = [];
  devices.forEach(([, main], i) => {
    const ip = `172.19.26.${11 + i * 7}`;
    for (const cls of [main, 'office', 'normal']) {
      conns.push({ id: '*' + (nextId++).toString(16).toUpperCase(), ip, cls, ob: 0, rb: 0, level: Math.random() });
    }
  });
  const macOf = (i) => `F4:2A:7C:${(16 + i).toString(16).toUpperCase()}:${(40 + i * 3).toString(16).toUpperCase()}:9B`;

  return function tick() {
    const dt = cfg.pollMs / 1000;
    const perClass = { top: [0, 0], office: [0, 0], normal: [0, 0], bulk: [0, 0] };
    let totalDown = 0;
    for (const c of conns) {
      c.level = Math.min(1, Math.max(0, c.level + (Math.random() - 0.5) * 0.35));
      const idle = c.ip.endsWith('.81') || c.ip.endsWith('.95');
      c.down = idle ? 0 : base[c.cls] * c.level;
      totalDown += c.down;
    }
    const scale = totalDown > 37e6 ? 37e6 / totalDown : 1;
    for (const c of conns) {
      const down = c.down * scale;
      const up = down * (c.cls === 'top' ? 0.35 : 0.12);
      c.rb += (down * dt) / 8;
      c.ob += (up * dt) / 8;
      perClass[c.cls][0] += down;
      perClass[c.cls][1] += up;
    }
    const sumDown = Object.values(perClass).reduce((s, v) => s + v[0], 0);
    const sumUp = Object.values(perClass).reduce((s, v) => s + v[1], 0);
    counters.wanRx += (sumDown * 1.02 * dt) / 8;
    counters.wanTx += (sumUp * 1.05 * dt) / 8;
    counters.lanTx += (sumDown * dt) / 8;
    counters.lanRx += (sumUp * dt) / 8;
    for (const k of Object.keys(blk)) if (Math.random() < 0.08) blk[k] += 1 + Math.floor(Math.random() * 3);
    if (Math.random() < 0.1) adlistHits++;

    const queues = [
      { name: 'QOS26-DOWNLOAD', 'max-limit': '40M', bytes: '0', rate: String(Math.round(sumDown)) },
      { name: 'QOS26-UPLOAD', 'max-limit': '15M', bytes: '0', rate: String(Math.round(sumUp)) },
    ];
    QUEUE_CLASS.forEach((k, i) => {
      const n = i + 1;
      const active = new Set(conns.filter((c) => c.cls === k && c.down > 0).map((c) => c.ip)).size;
      qBytes[k] = (qBytes[k] || 0) + (perClass[k][0] * dt) / 8;
      queues.push({ name: `QOS26-D${n}-X`, rate: String(Math.round(perClass[k][0])), bytes: String(Math.round(qBytes[k])), dropped: k === 'bulk' ? String(Math.floor(qBytes[k] / 9e5)) : '0', 'pcq-queues': String(active) });
      queues.push({ name: `QOS26-U${n}-X`, rate: String(Math.round(perClass[k][1])) });
    });

    return {
      raw: {
        resource: { version: '7.25 (stable)', 'board-name': 'hAP ax^2', uptime: '12d4h31m', 'cpu-load': String(8 + Math.floor(Math.random() * 10)), 'total-memory': '1073741824', 'free-memory': String(780e6 + Math.floor(Math.random() * 2e7)) },
        identity: { name: '8271_KOTA_TERNATE' },
        ifaces: [
          { name: cfg.wanIf, 'rx-byte': String(Math.round(counters.wanRx)), 'tx-byte': String(Math.round(counters.wanTx)), running: 'true', 'link-downs': '2' },
          { name: cfg.lanIf, 'rx-byte': String(Math.round(counters.lanRx)), 'tx-byte': String(Math.round(counters.lanTx)), running: 'true', 'link-downs': '5' },
        ],
        queues,
        leases: devices.map(([host], i) => ({ address: `172.19.26.${11 + i * 7}`, 'mac-address': macOf(i), 'host-name': host, status: 'bound', 'last-seen': `${Math.floor(Math.random() * 50)}s` }))
          .concat([{ address: '172.19.26.200', 'mac-address': 'AC:12:03:44:5E:01', 'host-name': 'PRINTER-EPSON', comment: 'Printer ruang umum', status: 'bound', 'last-seen': '3m10s' }]),
        arp: devices.map((_, i) => ({ address: `172.19.26.${11 + i * 7}`, 'mac-address': macOf(i), status: i === 10 ? 'stale' : 'reachable' })),
        conns: conns.map((c) => ({ '.id': c.id, 'src-address': `${c.ip}:${40000 + parseInt(c.id.slice(1), 16)}`, 'dst-address': '103.10.20.30:443', 'orig-bytes': String(Math.round(c.ob)), 'repl-bytes': String(Math.round(c.rb)), 'connection-mark': `qos26-${c.cls}` })),
        filters: Object.entries(blk).map(([k, v]) => ({ comment: `BLOK-26 ${k}`, packets: String(v), bytes: String(v * 600) }))
          .concat([{ comment: 'BLOK-26 tutup DNS dari internet (udp)', packets: '0' }]),
        adlist: [{ url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts', 'match-count': String(adlistHits) }],
        addrs: [{ address: '172.19.26.1/24' }],
      },
      errors: [],
    };
  };
}

// Pola jam kerja: sibuk 08-16, ping naik saat bandwidth penuh, satu kali putus
function demoLoad(t) {
  const d = new Date(t);
  const h = d.getHours() + d.getMinutes() / 60;
  const work = h >= 7.5 && h <= 16.5 ? Math.sin(((h - 7.5) / 9) * Math.PI) : 0;
  return Math.min(1, 0.08 + work * 0.95 + (Math.random() - 0.5) * 0.15);
}
function demoHealth(t = Date.now()) {
  const load = demoLoad(t);
  const jam = load > 0.85 ? (load - 0.85) * 1200 : 0;
  return {
    time: t,
    pings: [
      { key: 'gw', role: 'gw', label: 'Modem IndiHome', address: '192.168.1.1', rtt: 1 + Math.random(), max: 3, loss: 0 },
      { key: 'inet', role: 'inet', label: 'Internet', address: '8.8.8.8', rtt: 32 + jam + Math.random() * 15, max: 60 + jam * 1.5, loss: load > 0.95 ? 4 : 0 },
      { key: 'bakudapa.malutprov.go.id', role: 'site', label: 'BAKUDAPA', address: 'bakudapa.malutprov.go.id', rtt: 45 + jam + Math.random() * 20, max: 80 + jam, loss: 0 },
    ],
    pool: { name: 'pool-wifi', size: 244, used: Math.round(60 + load * 175), leaseTime: '1d', server: 'dhcp-wifi' },
    errors: [],
  };
}
function demoMinutes() {
  const now = Math.floor(Date.now() / 60000) * 60000;
  firstT = now - 3 * 864e5;
  const outageAt = now - 5 * 3600e3;
  for (let t = firstT; t < now; t += 60000) {
    if (t >= outageAt && t < outageAt + 14 * 60000) { minutes.push({ t, n: 20, ok: 0, tunnel: 'down' }); continue; }
    const load = demoLoad(t);
    const hh = demoHealth(t);
    const down = load * 40e6;
    minutes.push({
      t, n: 20, ok: 20, down: Math.round(down * 0.9), downMax: Math.round(Math.min(40e6, down * 1.1)),
      up: Math.round(down * 0.12), upMax: Math.round(down * 0.2), cpu: Math.round(6 + load * 30), online: Math.round(8 + load * 42),
      conns: Math.round(200 + load * 1800), lim: 40e6, limUp: 15e6,
      drop: { top: 0, office: 0, normal: load > 0.85 ? 40 : 0, bulk: load > 0.7 ? Math.round(load * 600) : 0 },
      lanDowns: Math.random() < 0.002 ? 1 : 0, wanDowns: 0,
      ping: Object.fromEntries(hh.pings.map((p) => [p.key, { rtt: p.rtt, loss: p.loss }])),
      pool: { used: hh.pool.used, size: hh.pool.size },
    });
  }
}

// ---- Loop polling + server web ----
let snapshot = { ok: false, demo: DEMO, time: Date.now(), errors: ['Menunggu data pertama dari router...'], history: [], clients: [] };
const demoTick = DEMO ? makeDemo() : null;

async function loop() {
  const started = Date.now();
  try {
    const { raw, errors } = DEMO ? demoTick() : await fetchRouter();
    snapshot = build(raw, started, errors);
    if (errors.length) log(`Sebagian data gagal: ${errors.join(' | ')}`);
    else if (lastLogMsg.startsWith('Sebagian data gagal')) log('Data router kembali normal.');
  } catch (e) {
    snapshot = { ...snapshot, ok: false, time: started, errors: [e.message] };
    log('Error polling: ' + e.message);
  }
  watchTunnel(snapshot.ok);
  try {
    track(snapshot);
    trackUsage(snapshot);
  } catch (e) { log('Error riwayat: ' + e.message); }
  setTimeout(loop, Math.max(200, cfg.pollMs - (Date.now() - started)));
}

async function healthLoop() {
  const started = Date.now();
  if (DEMO) health = demoHealth();
  else if (snapshot.ok) {
    try { health = await fetchHealth(); } catch (e) { health = { ...health, errors: [errText(e)] }; }
  }
  setTimeout(healthLoop, Math.max(1000, cfg.healthMs - (Date.now() - started)));
}

const publicSnapshot = () => ({
  ...snapshot,
  tunnel: { enabled: tunnel.enabled, state: tunnel.state, since: tunnel.since, restarts: tunnel.restarts, lastError: tunnel.lastError },
  health: { ...health, fresh: Date.now() - health.time < cfg.healthMs * 3 },
});

const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (url.pathname === '/api/snapshot') {
    json(publicSnapshot());
  } else if (url.pathname === '/api/history') {
    json(historyApi(url.searchParams.get('hours')));
  } else if (url.pathname === '/api/export.csv') {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : dayOf(Date.now());
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="monitor-ternate-${date}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end('﻿' + exportCsv(date));
  } else if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(INDEX).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});
server.on('error', (e) => {
  log(`Server web gagal jalan: ${e.message}`);
  // kode 3 = sudah ada monitoring lain yang jalan -> jalan-terus.cmd berhenti mencoba
  process.exit(e.code === 'EADDRINUSE' ? 3 : 1);
});

function shutdown() {
  if (sshProc) sshProc.kill();
  saveUsage();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => { if (sshProc) sshProc.kill(); });

if (DEMO) demoMinutes();
loadHistory();
loadUsage();
server.listen(cfg.port, cfg.listenHost, () => {
  const lan = cfg.listenHost === '127.0.0.1' ? '' : Object.values(os.networkInterfaces()).flat()
    .filter((a) => a.family === 'IPv4' && !a.internal).map((a) => `http://${a.address}:${cfg.port}`).join(' ');
  log(`Web monitoring: http://localhost:${cfg.port} ${lan}  ${DEMO ? '(MODE DEMO)' : `-> ${cfg.url} sebagai ${cfg.user}`}`);
  if (!DEMO && !cfg.pass) log('MT_PASS di file .env masih kosong.');
  if (tunnel.enabled) {
    if (!fs.existsSync(cfg.ssh.key)) log(`SSH key tidak ditemukan: ${cfg.ssh.key}`);
    killStaleTunnels();
    log(`Membuka tunnel SSH ke ${cfg.ssh.user}@${cfg.ssh.host}:${cfg.ssh.port}`);
    startTunnel();
  }
  loop();
  healthLoop();
});
