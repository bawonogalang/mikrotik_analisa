# Hapus semua konfigurasi BLOK-26 (judi + game online)
/ip firewall filter remove [find comment~"BLOK-26"]
/ip firewall nat remove [find comment~"BLOK-26"]
/ip firewall address-list remove [find comment~"BLOK-26"]
/ip dns static remove [find comment~"BLOK-26"]
/ip dns adlist remove [find url~"StevenBlack"]
/ip dns cache flush
:put "BLOK-26 sudah dihapus."
