# MikroTik Analisa: WiFi 172.19.26.0/24

Skrip MikroTik dan web monitoring untuk WiFi kantor di router hAP ax² (RouterOS 7).

## Isi

| File | Fungsi |
|---|---|
| `qos-ternate-172-19-26.rsc` | QoS 4 kelas (BAKUDAPA, office/chat, normal, streaming/download) dengan queue tree + PCQ |
| `qos-ternate-rollback.rsc` | Membatalkan QoS di atas |
| `blok-judi-game-26.rsc` | Blokir situs judi dan game (DNS dipaksa ke router, blocklist DNS, aturan TLS SNI, tutup DoH/DoT) |
| `blok-judi-game-rollback.rsc` | Membatalkan blokir |
| `monitoring/` | Web monitoring (Node.js, tanpa dependensi) yang membaca router lewat REST API melalui tunnel SSH |

## Monitoring

- `monitoring/setup-router-monitor.rsc` membuat user read-only `webmon` di router, dan `setup-permanen.rsc` memasang SSH key-nya.
- Salin `monitoring/.env.example` menjadi `.env`, lalu isi `MT_PASS`, `SSH_HOST` (alamat DDNS router), `SSH_PORT` dan `SSH_KEY`.
- `pasang-permanen.ps1` memasang monitoring ke `%USERPROFILE%\MonitorTernate` dan menyalakannya saat login.
- `pasang-tanpa-login.cmd` (sebagai Administrator) membuat Scheduled Task supaya monitoring menyala saat PC hidup, tanpa perlu login.
- `buat-rekap.cmd` membuat file rekap 7 hari (`rekap\rekap-<tanggal>.json`) untuk dashboard rekap mingguan.

Dashboard: `http://localhost:8090`, atau dari PC lain di jaringan kalau `LISTEN_HOST=0.0.0.0`.

File `.env`, SSH key, log, riwayat (`data/`) dan rekap sengaja tidak disimpan di repo ini karena berisi password dan data perangkat kantor.
