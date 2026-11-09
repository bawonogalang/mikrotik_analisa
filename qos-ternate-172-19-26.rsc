# =====================================================================
# QoS / Pembagian Bandwidth WiFi 172.19.26.0/24 - MikroTik KOTA TERNATE
# RouterOS 7.x  |  Internet IndiHome 50 Mbps (1:8 / shared)
#
# Kelas prioritas (1 = tertinggi):
#   1 TOP     : bakudapa.malutprov.go.id (web + app mobile BAKUDAPA)
#   2 OFFICE  : chat (WA, Telegram), meeting (Zoom, Meet, Teams), email,
#               Office 365, Google Docs/Gmail, situs *.go.id, DNS, ping
#   3 NORMAL  : browsing biasa / lainnya
#   4 BULK    : YouTube, TikTok, Netflix, IG/FB video, download file,
#               update Windows/Play Store, dan koneksi > 5 MB
# Di tiap kelas bandwidth dibagi rata per perangkat (PCQ).
#
# Semua item diberi comment "QOS-26" -> aman dijalankan ulang,
# dan bisa dihapus total dengan qos-ternate-rollback.rsc
# =====================================================================

# ---- 0. Bersihkan konfigurasi QOS-26 lama (aman kalau belum ada) ----
/queue tree remove [find comment~"QOS-26"]
/ip firewall mangle remove [find comment~"QOS-26"]
/ip firewall filter remove [find comment~"QOS-26"]
/ip firewall address-list remove [find comment~"QOS-26"]
/queue type remove [find name~"^qos26-"]

# ---- 1. Address list domain BAKUDAPA (di-resolve otomatis oleh router) ----
/ip firewall address-list add list=QOS26-BAKUDAPA address=bakudapa.malutprov.go.id comment="QOS-26 BAKUDAPA web/app"

# Tujuan lokal/VPN (LAN 172.19.25.x, JARKOMDAT, WireGuard, OVPN, dll) tidak ikut kuota internet
:foreach n in={"10.0.0.0/8";"172.16.0.0/12";"192.168.0.0/16"} do={ /ip firewall address-list add list=QOS26-LOKAL address=$n comment="QOS-26 tujuan lokal" }

# ---- 2. FastTrack: lalu lintas 172.19.26.x jangan di-fasttrack ----
# (paket yang di-fasttrack melewati mangle & queue, jadi QoS tidak jalan)
:if ([:len [/ip firewall filter find action=fasttrack-connection]] > 0) do={ /ip firewall filter add chain=forward action=accept connection-state=established,related src-address=172.19.26.0/24 comment="QOS-26 lewati fasttrack (upload)" place-before=[:pick [/ip firewall filter find action=fasttrack-connection] 0]; /ip firewall filter add chain=forward action=accept connection-state=established,related dst-address=172.19.26.0/24 comment="QOS-26 lewati fasttrack (download)" place-before=[:pick [/ip firewall filter find action=fasttrack-connection] 0] }

# ---- 3. Mangle: tandai koneksi per kelas ----
/ip firewall mangle add chain=forward src-address=172.19.26.0/24 dst-address-list=!QOS26-LOKAL connection-state=new connection-mark=no-mark action=mark-connection new-connection-mark=qos26-normal passthrough=yes comment="QOS-26 1 default koneksi baru = normal"

# Office/chat berdasarkan port (DNS, NTP, call WA/Zoom/Meet/Teams, email, remote desktop)
/ip firewall mangle add chain=forward src-address=172.19.26.0/24 connection-mark=qos26-normal protocol=udp dst-port=53,123,3478-3481,8801-8810,19302-19309 action=mark-connection new-connection-mark=qos26-office passthrough=yes comment="QOS-26 2 office port UDP"
/ip firewall mangle add chain=forward src-address=172.19.26.0/24 connection-mark=qos26-normal protocol=tcp dst-port=53,22,25,110,143,465,587,993,995,3389,5938,7070 action=mark-connection new-connection-mark=qos26-office passthrough=yes comment="QOS-26 2 office port TCP"
/ip firewall mangle add chain=forward src-address=172.19.26.0/24 connection-mark=qos26-normal protocol=icmp action=mark-connection new-connection-mark=qos26-office passthrough=yes comment="QOS-26 2 office ping"

# Office/chat berdasarkan nama situs HTTPS (TLS SNI)
:foreach h in={"*whatsapp.net";"*whatsapp.com";"*telegram.org";"*t.me";"*zoom.us";"*meet.google.com";"*mail.google.com";"*docs.google.com";"*teams.microsoft.com";"*.office.com";"*.office365.com";"*.outlook.com";"*.microsoftonline.com";"*.sharepoint.com";"*.go.id"} do={ /ip firewall mangle add chain=forward src-address=172.19.26.0/24 connection-mark=qos26-normal protocol=tcp tls-host=$h action=mark-connection new-connection-mark=qos26-office passthrough=yes comment=("QOS-26 3 office " . $h) }

# Streaming & download besar berdasarkan nama situs HTTPS (TLS SNI)
:foreach h in={"*.googlevideo.com";"*youtube.com";"*.youtube-nocookie.com";"*tiktok*";"*.byteoversea.com";"*.ibyteimg.com";"*.nflxvideo.net";"*netflix.com";"*.fbcdn.net";"*.cdninstagram.com";"*vidio.com";"*.akamaized.net";"*.gvt1.com";"*.windowsupdate.com";"*.delivery.mp.microsoft.com";"*.steamcontent.com";"*mediafire.com";"*mega.nz";"*.mega.co.nz"} do={ /ip firewall mangle add chain=forward src-address=172.19.26.0/24 connection-mark=qos26-normal protocol=tcp tls-host=$h action=mark-connection new-connection-mark=qos26-bulk passthrough=yes comment=("QOS-26 4 bulk " . $h) }

# Koneksi "normal" yang sudah lewat 5 MB = download/streaming -> bulk
# (menangkap download HTTP biasa & YouTube via QUIC yang tidak terbaca SNI-nya)
/ip firewall mangle add chain=forward connection-mark=qos26-normal connection-bytes=5000000-0 action=mark-connection new-connection-mark=qos26-bulk passthrough=yes comment="QOS-26 5 koneksi >5MB = bulk"

# BAKUDAPA paling akhir supaya selalu menang (prioritas tertinggi)
/ip firewall mangle add chain=forward src-address=172.19.26.0/24 dst-address-list=QOS26-BAKUDAPA connection-mark=!no-mark action=mark-connection new-connection-mark=qos26-top passthrough=yes comment="QOS-26 6 BAKUDAPA (IP)"
/ip firewall mangle add chain=forward src-address=172.19.26.0/24 connection-mark=!no-mark protocol=tcp tls-host=*bakudapa* action=mark-connection new-connection-mark=qos26-top passthrough=yes comment="QOS-26 6 BAKUDAPA (web/app TLS)"

# Tandai paket upload/download per kelas untuk queue tree
:foreach c in={"top";"office";"normal";"bulk"} do={ /ip firewall mangle add chain=forward src-address=172.19.26.0/24 connection-mark=("qos26-" . $c) action=mark-packet new-packet-mark=("q26-up-" . $c) passthrough=no comment=("QOS-26 7 paket upload " . $c); /ip firewall mangle add chain=forward dst-address=172.19.26.0/24 connection-mark=("qos26-" . $c) action=mark-packet new-packet-mark=("q26-down-" . $c) passthrough=no comment=("QOS-26 7 paket download " . $c) }

# ---- 4. Queue type PCQ (bagi rata per perangkat) ----
/queue type add name=qos26-down kind=pcq pcq-classifier=dst-address pcq-rate=0
/queue type add name=qos26-up kind=pcq pcq-classifier=src-address pcq-rate=0
# streaming/download: maks 4 Mbps per perangkat (cukup untuk YouTube 1080p)
/queue type add name=qos26-down-bulk kind=pcq pcq-classifier=dst-address pcq-rate=4M
/queue type add name=qos26-up-bulk kind=pcq pcq-classifier=src-address pcq-rate=1M

# ---- 5. Queue tree ----
# max-limit total dibuat di bawah 50M karena IndiHome 1:8 (shared).
# SESUAIKAN dengan hasil speedtest jam sibuk (sekitar 85-90% dari hasil itu).
/queue tree add name=QOS26-DOWNLOAD parent=global max-limit=40M comment="QOS-26 total download"
/queue tree add name=QOS26-D1-BAKUDAPA parent=QOS26-DOWNLOAD packet-mark=q26-down-top priority=1 limit-at=8M max-limit=40M queue=qos26-down comment="QOS-26 download prioritas 1"
/queue tree add name=QOS26-D2-OFFICE parent=QOS26-DOWNLOAD packet-mark=q26-down-office priority=2 limit-at=15M max-limit=40M queue=qos26-down comment="QOS-26 download prioritas 2"
/queue tree add name=QOS26-D3-NORMAL parent=QOS26-DOWNLOAD packet-mark=q26-down-normal priority=4 limit-at=10M max-limit=40M queue=qos26-down comment="QOS-26 download prioritas 3"
/queue tree add name=QOS26-D4-BULK parent=QOS26-DOWNLOAD packet-mark=q26-down-bulk priority=8 limit-at=5M max-limit=28M queue=qos26-down-bulk comment="QOS-26 download prioritas 4 (streaming/download)"

/queue tree add name=QOS26-UPLOAD parent=global max-limit=15M comment="QOS-26 total upload"
/queue tree add name=QOS26-U1-BAKUDAPA parent=QOS26-UPLOAD packet-mark=q26-up-top priority=1 limit-at=3M max-limit=15M queue=qos26-up comment="QOS-26 upload prioritas 1"
/queue tree add name=QOS26-U2-OFFICE parent=QOS26-UPLOAD packet-mark=q26-up-office priority=2 limit-at=5M max-limit=15M queue=qos26-up comment="QOS-26 upload prioritas 2"
/queue tree add name=QOS26-U3-NORMAL parent=QOS26-UPLOAD packet-mark=q26-up-normal priority=4 limit-at=4M max-limit=15M queue=qos26-up comment="QOS-26 upload prioritas 3"
/queue tree add name=QOS26-U4-BULK parent=QOS26-UPLOAD packet-mark=q26-up-bulk priority=8 limit-at=2M max-limit=9M queue=qos26-up-bulk comment="QOS-26 upload prioritas 4 (streaming/download)"

:put "QOS-26 terpasang. Cek: /queue tree print stats"
