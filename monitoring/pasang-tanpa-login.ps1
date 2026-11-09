# Menyalakan web monitoring saat PC hidup, tanpa perlu ada yang login:
#   - membuat Scheduled Task "Monitor WiFi Ternate" (mode S4U: password Windows tidak disimpan)
#   - menguji task itu; kalau gagal, task dihapus dan monitoring dijalankan dengan cara lama
# Shortcut di folder Startup dibiarkan sebagai cadangan: kalau monitoring sudah jalan,
# yang dari Startup langsung berhenti sendiri (kode 3 di jalan-terus.cmd).
# Aman dijalankan ulang.
param([string]$User)
$ErrorActionPreference = 'Stop'
$task = 'Monitor WiFi Ternate'
$dst = $PSScriptRoot

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  # Minta hak Administrator; nama akun dibawa supaya task tetap milik akun ini
  Start-Process powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-User', $me.Name)
  return
}
if (-not $User) { $User = $me.Name }

function Stop-Monitor {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*jalan-terus.cmd*') -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*MonitorTernate*server.js*') -or
    ($_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*mt_ternate_webmon*')
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# Lolos kalau server berjalan di luar sesi login (session 0) dan tunnel ke router tersambung
function Test-Monitor {
  $c = Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $false }
  if ((Get-Process -Id $c.OwningProcess).SessionId -ne 0) { return $false }
  try { $s = Invoke-RestMethod 'http://127.0.0.1:8090/api/snapshot' -TimeoutSec 5 } catch { return $false }
  return [bool]($s.ok -and $s.tunnel.state -eq 'up')
}

try {
  if ((Split-Path -Leaf $dst) -ne 'MonitorTernate') { throw "Jalankan dari folder MonitorTernate, bukan $dst" }

  $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\cmd.exe') -Argument "/c `"$dst\jalan-terus.cmd`"" -WorkingDirectory $dst
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Web monitoring WiFi MikroTik Ternate' -Force | Out-Null
  Write-Output "Task dibuat untuk akun $User. Menguji..."

  Stop-Monitor
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $task

  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    Start-Sleep -Seconds 2
    $ok = Test-Monitor
  }
  if (-not $ok) { throw 'Monitoring tidak tersambung ke router dalam 60 detik lewat task.' }

  Write-Output ''
  Write-Output 'BERHASIL. Monitoring sekarang berjalan tanpa perlu login.'
  Write-Output 'Tunnel ke router tersambung: http://172.25.10.253:8090'
} catch {
  Write-Output ''
  Write-Output "GAGAL: $($_.Exception.Message)"
  Write-Output 'Task dibatalkan, monitoring dijalankan lagi dengan cara lama (saat login).'
  Stop-Monitor
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
  }
  Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList "`"$dst\mulai-monitor.vbs`""
} finally {
  Write-Output ''
  Read-Host 'Tekan Enter untuk menutup'
}
