// Membuat file rekap 7 hari untuk dashboard "Rekap Mingguan WiFi Ternate".
//   node rekap-mingguan.js              -> 7 hari penuh sampai kemarin (WIT)
//   node rekap-mingguan.js 2026-11-09   -> 7 hari penuh sampai tanggal itu
// Hasil: rekap\rekap-<tanggal akhir>.json, satu daftar baris dengan kolom "bagian".
const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA = path.join(__dirname, 'data');
const OUT_DIR = path.join(__dirname, 'rekap');
const WIT = 9 * 3600e3;
const RAP_MAC = '70:85:6C:8C:47:A1'; // AP Ruijie RAP2200E yang masih mode router (NAT)
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const arg = process.argv[2];
if (arg && !/^\d{4}-\d{2}-\d{2}$/.test(arg)) { console.error('Format tanggal: YYYY-MM-DD'); process.exit(1); }
const todayWit = new Date(Date.now() + WIT).toISOString().slice(0, 10);
const akhir = arg || new Date(Date.parse(todayWit + 'T00:00:00Z') - 86400e3).toISOString().slice(0, 10);
const endT = Date.parse(akhir + 'T00:00:00Z') - WIT + 86400e3; // eksklusif
const startT = endT - 7 * 86400e3;
const lastT = Math.min(endT, Date.now()) - 60000;

const iso = (t) => new Date(t + WIT).toISOString().slice(0, 16).replace('T', ' ');
const witDate = (t) => new Date(t + WIT).toISOString().slice(0, 10);
const witHour = (t) => new Date(t + WIT).getUTCHours();
const dow = (t) => new Date(t + WIT).getUTCDay();
const tgl = (s) => Number(s.slice(8, 10)) + ' ' + BULAN[Number(s.slice(5, 7)) - 1];
const jam = (s) => tgl(s) + ' ' + s.slice(11, 16).replace(':', '.');
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r1 = (x, d = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const id = (x, d = 1) => (x == null ? '-' : x.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d }));

function snapshot() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8090/api/snapshot', { timeout: 10000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  // Riwayat per menit (file per tanggal PC, jadi baca satu hari ekstra di kedua sisi)
  const rows = [];
  for (const f of fs.readdirSync(DATA).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))) {
    const d = Date.parse(f.slice(0, 10) + 'T00:00:00Z');
    if (d < startT - 2 * 86400e3 || d > endT + 86400e3) continue;
    for (const l of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      const r = JSON.parse(l);
      if (r.t >= startT && r.t < endT) rows.push(r);
    }
  }
  rows.sort((a, b) => a.t - b.t);
  if (!rows.length) { console.error('Tidak ada riwayat untuk periode ini.'); process.exit(1); }

  // Polling pertama setelah tunnel tersambung lagi kadang menghitung penghitung kumulatif sebagai selisih.
  // 40 Mbps penuh kira-kira 200 ribu paket per menit, jadi angka di atas itu salah hitung dan dibuang.
  for (const r of rows) {
    const dr = r.drop || {};
    if ((dr.top || 0) + (dr.office || 0) + (dr.normal || 0) + (dr.bulk || 0) > 250000) r.drop = {};
    if (r.down > 150e6) { r.down = null; r.ok = 0; }
  }
  const bad = (r) => r.ok < 0.8 * r.n; // sebagian besar polling gagal: router tak terjangkau
  const good = (r) => !bad(r);

  // Gangguan: monitor mati (tidak ada baris) dan router tak terjangkau
  const ev = [];
  let prev = startT - 60000;
  for (const r of [...rows, { t: lastT + 60000, last: true }]) {
    if (r.t - prev > 3 * 60000) ev.push({ jenis: 'Monitor mati', s: prev + 60000, e: r.t - 60000, m: Math.round((r.t - prev) / 60000) - 1 });
    prev = r.t;
  }
  let cur = null;
  for (const r of rows) {
    if (!bad(r)) continue;
    if (cur && r.t - cur.e <= 6 * 60000) { cur.e = r.t; cur.m++; }
    else { cur = { jenis: 'Router tak terjangkau', s: r.t, e: r.t, m: 1 }; ev.push(cur); }
  }
  const gangguan = ev.sort((a, b) => a.s - b.s).map((x) => ({
    bagian: 'gangguan', mulai: iso(x.s), selesai: iso(x.e + 60000), durasiMenit: Math.round((x.e - x.s) / 60000) + 1, menitTerganggu: x.m, jenis: x.jenis,
    keterangan: x.jenis === 'Monitor mati' ? 'PC monitoring mati atau monitor berhenti, data tidak tercatat'
      : x.m >= 10 ? 'Koneksi ke router putus-sambung berulang' : 'Gangguan singkat koneksi ke router',
  }));

  // Per hari (WIT)
  const days = {};
  for (let t = startT; t < endT; t += 86400e3) {
    const d = witDate(t);
    days[d] = { tanggal: d, hari: HARI[dow(t)], akhirPekan: dow(t) === 0 || dow(t) === 6, n: 0, good: 0, bad: 0, down: [], work: [], rtt: [], loss: [], bkd: [], online: 0, cpu: 0, sat: 0, bytesDown: 0 };
  }
  for (const r of rows) {
    const x = days[witDate(r.t)];
    x.n++;
    if (bad(r)) { x.bad++; continue; }
    x.good++;
    x.down.push(r.down); x.bytesDown += (r.down * 60) / 8;
    const p = r.ping || {};
    if (p.inet && p.inet.rtt != null) x.rtt.push(p.inet.rtt);
    if (p.inet) x.loss.push(p.inet.loss || 0);
    const b = p['bakudapa.malutprov.go.id']; if (b && b.rtt != null) x.bkd.push(b.rtt);
    x.online = Math.max(x.online, r.online || 0); x.cpu = Math.max(x.cpu, r.cpu || 0);
    if (r.down >= 0.85 * (r.lim || 40e6)) x.sat++;
    const h = witHour(r.t); if (h >= 8 && h < 16) x.work.push(r.down);
  }

  // Pemakaian per perangkat (file usage per tanggal PC)
  const usage = {}; const users = {};
  for (const d of Object.keys(days)) {
    const f = path.join(DATA, 'usage-' + d + '.json');
    if (!fs.existsSync(f)) continue;
    const list = Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).clients).map(([ip, c]) => ({ ip, ...c }));
    usage[d] = { tot: list.reduce((s, c) => s + c.down, 0), rap: list.filter((c) => c.mac === RAP_MAC).reduce((s, c) => s + c.down, 0), devices: list.length };
    for (const c of list) {
      const U = (users[c.mac || c.ip] ||= { mac: c.mac, names: new Set(), ips: new Set(), down: 0, up: 0, days: 0 });
      if (c.name) U.names.add(c.name); U.ips.add(c.ip); U.down += c.down; U.up += c.up; U.days++;
    }
  }

  const expectedOf = (d) => { const s = Date.parse(d + 'T00:00:00Z') - WIT; return Math.max(0, Math.min(1440, Math.round((lastT - s) / 60000) + 1)); };
  const harian = Object.values(days).map((x) => {
    const u = usage[x.tanggal] || { tot: 0, rap: 0, devices: 0 };
    return {
      bagian: 'harian', tanggal: x.tanggal, hari: x.hari, akhirPekan: x.akhirPekan ? 'ya' : 'tidak',
      menitTercatat: x.n, menitTanpaData: Math.max(0, expectedOf(x.tanggal) - x.n), menitTerganggu: x.bad, routerTerjangkauPct: x.n ? r1((100 * x.good) / x.n) : null,
      wifiGB: r1(u.tot / 1e9), rapGB: r1(u.rap / 1e9), lainGB: r1((u.tot - u.rap) / 1e9), rapPct: u.tot ? r1((100 * u.rap) / u.tot, 0) : null, perangkat: u.devices,
      wanDownGB: r1(x.bytesDown / 1e9), rataJamKerjaMbps: r1(avg(x.work) / 1e6), p95Mbps: r1(q(x.down, 0.95) / 1e6), menitPenuh: x.sat,
      pingRata: r1(avg(x.rtt)), pingP95: r1(q(x.rtt, 0.95)), lossPct: r1(avg(x.loss), 2), bakudapaRata: r1(avg(x.bkd)), onlineMaks: x.online, cpuMaks: x.cpu,
    };
  });

  const hours = Array.from({ length: 24 }, (_, h) => ({ h, down: [], online: [], rtt: [] }));
  for (const r of rows) {
    if (!good(r) || dow(r.t) === 0 || dow(r.t) === 6) continue;
    const H = hours[witHour(r.t)];
    H.down.push(r.down); H.online.push(r.online || 0);
    if (r.ping && r.ping.inet && r.ping.inet.rtt != null) H.rtt.push(r.ping.inet.rtt);
  }
  const perjam = hours.map((H) => ({ bagian: 'perjam', jam: H.h, rataMbps: r1(avg(H.down) / 1e6), p95Mbps: r1(q(H.down, 0.95) / 1e6), perangkatOnline: r1(avg(H.online), 0), ping: r1(avg(H.rtt)) }));

  const totalU = Object.values(users).reduce((s, u) => s + u.down, 0);
  const urut = Object.values(users).sort((a, b) => b.down - a.down);
  const pemakai = urut.slice(0, 10).map((u, i) => ({
    bagian: 'pemakai', peringkat: i + 1, nama: [...u.names].join(' / ') || '(tanpa nama)', ip: [...u.ips].join(', '),
    downloadGB: r1(u.down / 1e9), uploadGB: r1(u.up / 1e9, 2), porsiPct: totalU ? r1((100 * u.down) / totalU) : null, hariAktif: u.days,
  }));

  const snap = await snapshot();
  const blk = snap && snap.blocked;
  const goodRows = rows.filter(good);
  const kerja = perjam.filter((p) => p.jam >= 8 && p.jam < 16 && p.rataMbps != null);
  const hariAda = harian.filter((d) => d.pingRata != null);
  const rapDown = (users[RAP_MAC] && users[RAP_MAC].down) || 0;
  const gR = gangguan.filter((g) => g.jenis !== 'Monitor mati');
  const gM = gangguan.filter((g) => g.jenis === 'Monitor mati');
  const lim = (rows.find((r) => r.lim) || {}).lim / 1e6 || 40;
  const ring = {
    bagian: 'ringkasan',
    periode: tgl(witDate(startT)) + ' – ' + tgl(akhir) + ' ' + akhir.slice(0, 4),
    dibuat: iso(Date.now()),
    menitTercatat: rows.length, monitorMatiMenit: gM.reduce((s, g) => s + g.menitTerganggu, 0),
    routerTerganggu: gR.length, routerTergangguMenit: gR.reduce((s, g) => s + g.menitTerganggu, 0),
    ketersediaanPct: r1((100 * goodRows.length) / rows.length, 1),
    wifiGB: r1(totalU / 1e9), rapGB: r1(rapDown / 1e9), rapPct: totalU ? r1((100 * rapDown) / totalU, 0) : null,
    pingRata: r1(avg(goodRows.map((r) => r.ping && r.ping.inet && r.ping.inet.rtt).filter((x) => x != null))),
    pingAwal: hariAda.length ? hariAda[0].pingRata : null, pingAkhir: hariAda.length ? hariAda[hariAda.length - 1].pingRata : null,
    lossPct: r1(avg(goodRows.map((r) => (r.ping && r.ping.inet && r.ping.inet.loss) || 0)), 2),
    menitPenuh: harian.reduce((s, d) => s + d.menitPenuh, 0),
    rataJamKerja: r1(avg(kerja.map((p) => p.rataMbps))), puncakJamKerjaP95: kerja.length ? Math.max(...kerja.map((p) => p.p95Mbps)) : null,
    batasMbps: lim,
    routerUptime: snap && snap.router ? snap.router.uptime : null,
    judi: blk ? blk.judi : null, game: blk ? blk.game : null, dnsJudi: blk ? blk.dnsBlocklist : null, bypass: blk ? blk.bypass : null,
  };

  // Uptime RouterOS, mis. "1w02:30:05" atau "3d4h5m6s"
  const up = ring.routerUptime || '';
  const part = (re) => Number((up.match(re) || [])[1] || 0);
  const hms = up.match(/(\d+):(\d+):(\d+)$/);
  const upMs = up ? ((part(/(\d+)w/) * 7 + part(/(\d+)d/)) * 86400 + (hms ? +hms[1] * 3600 + +hms[2] * 60 + +hms[3] : part(/(\d+)h/) * 3600 + part(/(\d+)m(?!s)/) * 60 + part(/(\d+)s/))) * 1000 : null;

  // Temuan otomatis, urut dari yang paling perlu ditindak
  const temuan = [];
  const add = (tingkat, teks) => temuan.push({ bagian: 'temuan', urut: temuan.length + 1, tingkat, teks });
  const top = urut[0];
  if (top && totalU && top.down / totalU >= 0.4) {
    const nm = [...top.names].join(' / ') || [...top.ips].join(', ');
    add('Prioritas', `${nm} (${[...top.ips].join(', ')}) memakai ${id(top.down / 1e9, 0)} GB, atau ${id((100 * top.down) / totalU, 0)}% download WiFi.` +
      (top.mac === RAP_MAC ? ' AP ini masih mode router (NAT), jadi semua penggunanya dihitung satu perangkat dan berbagi satu jatah. Ubah ke mode AP (bridge).' : ''));
  }
  const second = urut[1];
  if (second && totalU && second.down / totalU >= 0.1)
    add('Pantau', `${[...second.names].join(' / ') || '(tanpa nama)'} (${[...second.ips].join(', ')}) memakai ${id(second.down / 1e9, 1)} GB (${id((100 * second.down) / totalU, 0)}%) dalam ${second.days} hari. Cek apakah ini unduhan besar, backup atau streaming terus-menerus.`);
  if (ring.puncakJamKerjaP95 != null) {
    const penuh = ring.puncakJamKerjaP95 >= 0.85 * lim || ring.menitPenuh >= 60;
    add(penuh ? 'Pantau' : 'Aman', penuh
      ? `Jam kerja mulai mendekati batas: p95 tertinggi ${id(ring.puncakJamKerjaP95, 0)} Mbps dari batas ${id(lim, 0)} Mbps, ${ring.menitPenuh} menit di atas 85% batas. Pertimbangkan speedtest jam sibuk dan menaikkan batas QoS.`
      : `Kapasitas bukan penyebab lambat. Rata-rata jam kerja ${id(ring.rataJamKerja)} Mbps dan p95 tertinggi ${id(ring.puncakJamKerjaP95, 0)} Mbps, di bawah batas ${id(lim, 0)} Mbps. Hanya ${ring.menitPenuh} menit di atas 85% batas.`);
  }
  if (gR.length) {
    const lama = [...gR].sort((a, b) => b.menitTerganggu - a.menitTerganggu)[0];
    add(ring.routerTergangguMenit >= 30 ? 'Pantau' : 'Aman', `Koneksi monitor ke router terganggu ${gR.length} kali, total ${ring.routerTergangguMenit} menit. Terpanjang ${jam(lama.mulai)} WIT selama ${lama.durasiMenit} menit.` +
      (upMs == null ? '' : upMs >= Date.now() - startT ? ` Router tidak restart selama periode ini (uptime ${ring.routerUptime}), jadi gangguan ada di jalur internet.` : ` Router sempat restart (uptime ${ring.routerUptime}).`));
  } else add('Aman', 'Router selalu terjangkau dari monitor sepanjang periode.');
  if (ring.pingAwal != null && Math.abs(ring.pingAkhir - ring.pingAwal) >= 3)
    add('Pantau', `Ping ke internet ${ring.pingAkhir > ring.pingAwal ? 'naik' : 'turun'} dari ${id(ring.pingAwal)} ms (hari pertama) ke ${id(ring.pingAkhir)} ms (hari terakhir). Kalau berubah juga di jam sepi, penyebabnya rute IndiHome, bukan beban kantor.`);
  if (ring.lossPct != null && ring.lossPct >= 0.5) add('Pantau', `Packet loss ke internet rata-rata ${id(ring.lossPct, 2)}%, di atas wajar.`);
  if (blk) add('Aman', `Blokir berjalan. Aturan judi kena ${id(blk.judi, 0)} kali, game ${id(blk.game, 0)}, blocklist DNS judi ${id(blk.dnsBlocklist, 0)}, upaya DNS lain (DoH/DoT) ditolak ${id(blk.bypass, 0)} paket. Angka ini sejak router terakhir menyala.`);
  else add('Pantau', 'Penghitung blokir tidak terbaca karena monitoring sedang tidak berjalan saat rekap dibuat.');
  if (gM.length) add('Pantau', `${ring.monitorMatiMenit} menit data tidak tercatat karena monitor mati, terpanjang mulai ${jam([...gM].sort((a, b) => b.menitTerganggu - a.menitTerganggu)[0].mulai)} WIT.`);
  ring.kalimat = temuan.length && temuan[0].tingkat === 'Prioritas'
    ? `Satu perangkat memakai ${id((100 * top.down) / totalU, 0)}% download WiFi minggu ini. Itu yang paling perlu ditindak.`
    : temuan.some((t) => t.tingkat === 'Pantau') ? 'Jaringan berjalan, dengan beberapa hal yang perlu dipantau.' : 'Jaringan berjalan normal minggu ini.';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'rekap-' + akhir + '.json');
  fs.writeFileSync(out, JSON.stringify([ring, ...temuan, ...harian, ...perjam, ...pemakai, ...gangguan], null, 1));
  console.log('Periode   : ' + ring.periode + ' (WIT)');
  console.log('File      : ' + out);
  console.log('Temuan    :');
  for (const t of temuan) console.log('  [' + t.tingkat + '] ' + t.teks);
  if (!snap) console.log('Catatan   : monitoring tidak berjalan, penghitung blokir kosong.');
})();
