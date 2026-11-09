# =====================================================================
# Persiapan web monitoring (REST API) - MikroTik KOTA TERNATE (RouterOS 7)
#
# - Membuat user READ-ONLY "webmon" khusus untuk web monitoring
#   (tidak bisa mengubah konfigurasi apa pun)
# - Mengizinkan SSH tunnel dari PC, supaya API tidak perlu dibuka ke internet
#
# Setelah import, isi password user webmon lewat Winbox:
#   System > Users > webmon > Password, lalu Enable
# =====================================================================

/user remove [find name=webmon comment~"MONITOR-26"]
/user group remove [find name=webmon-ro comment~"MONITOR-26"]
/user group add name=webmon-ro policy=read,api,rest-api comment="MONITOR-26 web monitoring read-only"
/user add name=webmon group=webmon-ro disabled=yes comment="MONITOR-26 isi password lalu enable"

# SSH local port forwarding (dipakai PC untuk tunnel ke REST API router)
/ip ssh set forwarding-enabled=local

:put "MONITOR-26 siap. Status layanan web router:"
/ip service print where name~"www"
