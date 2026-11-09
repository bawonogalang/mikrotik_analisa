# Memasang web monitoring secara permanen di PC ini:
#   - salin program ke %USERPROFILE%\MonitorTernate (data & .env yang sudah ada tidak ditimpa)
#   - menyala otomatis tiap login (shortcut di folder Startup)
#   - shortcut dashboard di Desktop
# Aman dijalankan ulang untuk update program.
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE 'MonitorTernate'

New-Item -ItemType Directory -Force -Path $dst, (Join-Path $dst 'public') | Out-Null
foreach ($f in 'server.js', 'jalan-terus.cmd', 'mulai-monitor.vbs', 'berhenti-monitor.cmd', 'pasang-tanpa-login.cmd', 'pasang-tanpa-login.ps1', 'rekap-mingguan.js', 'buat-rekap.cmd', '.env.example', 'BACA-SAYA.txt') {
  Copy-Item (Join-Path $src $f) $dst -Force
}
Copy-Item (Join-Path $src 'public\index.html') (Join-Path $dst 'public') -Force

# .env: pakai yang lama kalau sudah ada, lalu tambahkan setting tunnel yang belum ada
$envFile = Join-Path $dst '.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $src '.env') $envFile }
$existing = (Get-Content $envFile) -replace '\s*=.*$', ''
$add = @()
foreach ($line in Get-Content (Join-Path $src '.env.example')) {
  if ($line -match '^(SSH_|TUNNEL_|PING_|KEEP_|LISTEN_)[A-Z_]*=' -and ($existing -notcontains ($line -replace '\s*=.*$', ''))) { $add += $line }
}
if ($add.Count) { Add-Content -Path $envFile -Encoding ascii -Value (@('', '# Ditambahkan oleh pasang-permanen.ps1') + $add) }

# Menyala otomatis setiap login
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Monitor WiFi Ternate.lnk'))
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $dst 'mulai-monitor.vbs') + '"'
$lnk.WorkingDirectory = $dst
$lnk.Description = 'Web monitoring WiFi MikroTik Ternate'
$lnk.Save()

# Shortcut dashboard di Desktop
Set-Content -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Monitor WiFi Ternate.url') -Encoding ascii -Value "[InternetShortcut]`r`nURL=http://localhost:8090/"

Write-Output "Terpasang di $dst"
Write-Output "Setting tunnel ditambahkan ke .env: $($add.Count) baris"
