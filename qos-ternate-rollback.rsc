# Hapus semua konfigurasi QOS-26 (kembali seperti sebelum dipasang)
/queue tree remove [find comment~"QOS-26"]
/ip firewall mangle remove [find comment~"QOS-26"]
/ip firewall filter remove [find comment~"QOS-26"]
/ip firewall address-list remove [find comment~"QOS-26"]
/queue type remove [find name~"^qos26-"]
:put "QOS-26 sudah dihapus."
