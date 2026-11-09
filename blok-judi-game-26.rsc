# =====================================================================
# Blokir JUDI ONLINE + GAME ONLINE - MikroTik KOTA TERNATE (RouterOS 7)
# Target: WiFi 172.19.26.0/24
#
# Lapisan blokir:
#   1. Klien .26 dipaksa memakai DNS router (DNS manual 8.8.8.8 dll dibelokkan)
#   2. DNS router menolak domain judi (blocklist + kata kunci) dan game online
#   3. DNS-over-HTTPS / DNS-over-TLS diblokir supaya DNS tidak bisa diakali
#   4. Firewall memutus koneksi HTTPS ke nama situs judi/game (TLS SNI)
#
# Semua item diberi comment "BLOK-26" -> aman dijalankan ulang,
# dan bisa dihapus total dengan blok-judi-game-rollback.rsc
# =====================================================================

# ---- 0. Bersihkan konfigurasi BLOK-26 lama ----
/ip firewall filter remove [find comment~"BLOK-26"]
/ip firewall nat remove [find comment~"BLOK-26"]
/ip firewall address-list remove [find comment~"BLOK-26"]
/ip dns static remove [find comment~"BLOK-26"]
/ip dns adlist remove [find url~"StevenBlack"]

# ---- 1. DNS router ----
/ip dns set allow-remote-requests=yes
# DNS router jangan terbuka dari internet
/ip firewall filter add chain=input in-interface=ether1_INTERNET protocol=udp dst-port=53 action=drop comment="BLOK-26 tutup DNS dari internet (udp)"
/ip firewall filter add chain=input in-interface=ether1_INTERNET protocol=tcp dst-port=53 action=drop comment="BLOK-26 tutup DNS dari internet (tcp)"

# Paksa semua DNS dari 172.19.26.x ke DNS router
/ip firewall nat add chain=dstnat src-address=172.19.26.0/24 dst-address-type=!local protocol=udp dst-port=53 action=redirect to-ports=53 comment="BLOK-26 paksa DNS router (udp)"
/ip firewall nat add chain=dstnat src-address=172.19.26.0/24 dst-address-type=!local protocol=tcp dst-port=53 action=redirect to-ports=53 comment="BLOK-26 paksa DNS router (tcp)"

# ---- 2. Domain judi online ----
# Blocklist judi internasional (diperbarui otomatis oleh router)
/ip dns adlist add url=https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts ssl-verify=no
# Kata kunci khas situs judol Indonesia
# (satu kata kunci per entri; regex gabungan ditolak RouterOS "too complex")
:foreach k in={"slot";"gacor";"togel";"judol";"judionline";"judibola";"casino";"kasino";"maxwin";"sbobet";"poker";"jackpot";"pragmaticplay";"pgsoft"} do={ /ip dns static add regexp=$k type=NXDOMAIN comment=("BLOK-26 judi " . $k) }

# ---- 3. Domain game online ----
:foreach k in={"mobilelegends";"moonton";"garena";"freefire";"pubg";"igamecj";"proximabeta";"levelinfinite";"honorofkings";"roblox";"rbxcdn";"hoyoverse";"mihoyo";"genshin";"riotgames";"riotcdn";"leagueoflegends";"playvalorant";"supercell";"higgs";"steampowered";"steamcontent";"steamserver";"steamstatic";"epicgames";"unrealengine";"callofduty";"activision";"playstation";"xboxlive"} do={ /ip dns static add regexp=$k type=NXDOMAIN comment=("BLOK-26 game " . $k) }

# ---- 4. Blokir DNS-over-HTTPS / DNS-over-TLS ----
:foreach a in={"8.8.8.8";"8.8.4.4";"1.1.1.1";"1.0.0.1";"9.9.9.9";"149.112.112.112";"208.67.222.222";"208.67.220.220";"94.140.14.14";"94.140.15.15";"185.228.168.168";"76.76.2.0"} do={ /ip firewall address-list add list=BLOK26-DOH address=$a comment="BLOK-26 server DoH" }

# ---- 5. Firewall forward (dipasang paling atas supaya kena sebelum rule accept) ----
/ip firewall filter add chain=forward src-address=172.19.26.0/24 protocol=tcp dst-port=853 action=reject reject-with=tcp-reset comment="BLOK-26 DoT (tcp 853)"
/ip firewall filter add chain=forward src-address=172.19.26.0/24 protocol=udp dst-port=853 action=drop comment="BLOK-26 DoT/DoQ (udp 853)"
/ip firewall filter add chain=forward src-address=172.19.26.0/24 dst-address-list=BLOK26-DOH protocol=tcp dst-port=443 action=reject reject-with=tcp-reset comment="BLOK-26 DoH ke IP DNS publik (tcp)"
/ip firewall filter add chain=forward src-address=172.19.26.0/24 dst-address-list=BLOK26-DOH protocol=udp dst-port=443 action=drop comment="BLOK-26 DoH ke IP DNS publik (udp)"
:foreach h in={"dns.google";"*cloudflare-dns.com";"dns.quad9.net";"*.nextdns.io";"*dns.adguard*";"doh.opendns.com";"doh.cleanbrowsing.org";"*.controld.com"} do={ /ip firewall filter add chain=forward src-address=172.19.26.0/24 protocol=tcp tls-host=$h action=reject reject-with=tcp-reset comment=("BLOK-26 DoH " . $h) }

# Judi online (nama situs HTTPS)
:foreach h in={"*slot*";"*gacor*";"*togel*";"*judol*";"*casino*";"*kasino*";"*maxwin*";"*sbobet*";"*poker*";"*pragmaticplay*";"*pgsoft*"} do={ /ip firewall filter add chain=forward src-address=172.19.26.0/24 protocol=tcp tls-host=$h action=reject reject-with=tcp-reset comment=("BLOK-26 judi " . $h) }

# Game online (nama situs HTTPS)
:foreach h in={"*mobilelegends*";"*moonton*";"*garena*";"*freefire*";"*pubg*";"*igamecj*";"*proximabeta*";"*levelinfinite*";"*roblox*";"*rbxcdn*";"*hoyoverse*";"*mihoyo*";"*riotgames*";"*supercell*";"*higgs*";"*steampowered*";"*steamcontent*";"*epicgames*"} do={ /ip firewall filter add chain=forward src-address=172.19.26.0/24 protocol=tcp tls-host=$h action=reject reject-with=tcp-reset comment=("BLOK-26 game " . $h) }

# Pindahkan semua rule BLOK-26 ke urutan paling atas (sebelum "accept established")
:if ([:len [/ip firewall filter find comment~"BLOK-26"]] < [:len [/ip firewall filter find]]) do={ /ip firewall filter move [find comment~"BLOK-26"] destination=0 }
:if ([:len [/ip firewall nat find comment~"BLOK-26"]] < [:len [/ip firewall nat find]]) do={ /ip firewall nat move [find comment~"BLOK-26"] destination=0 }

# Kosongkan cache DNS supaya blokir langsung berlaku
/ip dns cache flush

:put "BLOK-26 terpasang. Cek: /ip firewall filter print stats where comment~\"BLOK-26\""
