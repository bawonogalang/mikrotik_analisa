# MikroTik Analisa

Skrip MikroTik dan web monitoring WiFi kantor (RouterOS 7). Satu dashboard bisa memantau banyak router.

## Isi

| File | Fungsi |
|---|---|
| `qos-ternate-172-19-26.rsc` | QoS 4 kelas (BAKUDAPA, office/chat, normal, streaming/download) dengan queue tree + PCQ |
| `qos-ternate-rollback.rsc` | Membatalkan QoS di atas |
| `blok-judi-game-26.rsc` | Blokir situs judi dan game (DNS dipaksa ke router, blocklist DNS, aturan TLS SNI, tutup DoH/DoT) |
| `blok-judi-game-rollback.rsc` | Membatalkan blokir |
| `monitoring/` | Web monitoring (Node.js, tanpa dependensi) yang membaca banyak router lewat REST API melalui tunnel SSH atau VPN |

## Monitoring

- `monitoring/setup-router-monitor.rsc` membuat user read-only `webmon` di router, dan `setup-permanen.rsc` memasang SSH key-nya.
- Salin `monitoring/.env.example` menjadi `.env`, lalu isi `MT_PASS`, `SSH_HOST` (alamat DDNS router), `SSH_PORT` dan `SSH_KEY`.
- `pasang-permanen.ps1` memasang monitoring ke `%USERPROFILE%\MonitorTernate` dan menyalakannya saat login.
- `pasang-tanpa-login.cmd` (sebagai Administrator) membuat Scheduled Task supaya monitoring menyala saat PC hidup, tanpa perlu login.
- Router tambahan: salin `monitoring/routers.example.json` menjadi `routers.json` (satu baris per router), lalu jalankan `restart-monitor.cmd`. Dashboard membuka halaman "Semua lokasi" dan detail per router (`?r=<id>`).
- `buat-rekap.cmd` membuat file rekap 7 hari (`rekap\rekap-<tanggal>.json`) untuk dashboard rekap mingguan.

Dashboard: `http://localhost:8090`, atau dari PC lain di jaringan kalau `LISTEN_HOST=0.0.0.0`.

File `.env`, `routers.json`, SSH key, log, riwayat (`data/`) dan rekap sengaja tidak disimpan di repo ini karena berisi password dan data perangkat kantor.
