# Izin user webmon untuk monitoring permanen (comment MONITOR-26)
#  - ssh  : tunnel otomatis pakai SSH key dari PC monitoring, tanpa password
#  - test : ping ke modem / internet / BAKUDAPA untuk analisa lambat
# Tetap read-only: tidak bisa mengubah konfigurasi router.
# Upload bersama file webmon-ternate.pub, lalu: /import setup-permanen.rsc

/user group set [find name="webmon-ro"] policy=read,api,rest-api,ssh,test
:if ([:len [/file find name="webmon-ternate.pub"]] > 0) do={
  /user ssh-keys remove [find user="webmon"]
  /user ssh-keys import public-key-file=webmon-ternate.pub user=webmon
} else={
  :put "PERINGATAN: file webmon-ternate.pub belum di-upload"
}
/user ssh-keys print where user="webmon"
:put "Selesai: webmon bisa SSH pakai key dan ping (read-only)."
