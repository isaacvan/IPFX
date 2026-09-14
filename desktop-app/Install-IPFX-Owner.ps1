# ============================================================
#  Install-IPFX-Owner.ps1
#  Installs the "IPFX Owner" desktop app: copies the launcher and
#  icon to a stable location under %LOCALAPPDATA%\IPFXOwner and
#  creates a Desktop + Start Menu shortcut that opens the owner
#  performance board in its own app window.
#
#  Run:  right-click -> Run with PowerShell
#    or: powershell -ExecutionPolicy Bypass -File Install-IPFX-Owner.ps1
# ============================================================

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

# Stable install dir (independent of where the repo lives).
$dest = Join-Path $env:LOCALAPPDATA 'IPFXOwner'
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Copy-Item -Force (Join-Path $src 'IPFX-Owner.cmd') (Join-Path $dest 'IPFX-Owner.cmd')

# Icon: prefer the repo's favicon.ico, copied next to the launcher.
$icoCandidates = @(
  (Join-Path $src '..\favicon\favicon.ico'),
  (Join-Path $src '..\assets\images\favicon.ico')
)
$ico = $null
foreach ($c in $icoCandidates) { if (Test-Path $c) { $ico = (Resolve-Path $c).Path; break } }
if ($ico) {
  Copy-Item -Force $ico (Join-Path $dest 'IPFX-Owner.ico')
  $iconPath = Join-Path $dest 'IPFX-Owner.ico'
} else {
  $iconPath = "$env:SystemRoot\System32\shell32.dll,13"
}

$launcher = Join-Path $dest 'IPFX-Owner.cmd'

function New-Shortcut($linkPath) {
  $sh = New-Object -ComObject WScript.Shell
  $s = $sh.CreateShortcut($linkPath)
  # Run the .cmd via cmd.exe /c so no console window lingers, minimized.
  $s.TargetPath       = "$env:SystemRoot\System32\cmd.exe"
  $s.Arguments        = "/c `"$launcher`""
  $s.WorkingDirectory = $dest
  $s.IconLocation     = $iconPath
  $s.WindowStyle      = 7   # minimized (the console flashes closed instantly)
  $s.Description      = 'IPFX Owner - every trader''s performance and detector state'
  $s.Save()
}

# Desktop (handles OneDrive-redirected Desktop automatically via the shell folder).
$desktop = [Environment]::GetFolderPath('Desktop')
New-Shortcut (Join-Path $desktop 'IPFX Owner.lnk')

# Start Menu.
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
New-Shortcut (Join-Path $startMenu 'IPFX Owner.lnk')

Write-Host ""
Write-Host "  IPFX Owner installed." -ForegroundColor Green
Write-Host "  - Desktop shortcut:  $desktop\IPFX Owner.lnk"
Write-Host "  - Start Menu:        IPFX Owner"
Write-Host "  - App files:         $dest"
Write-Host ""
Write-Host "  Double-click 'IPFX Owner' to open the board. Sign in once with"
Write-Host "  your admin account; the app stays signed in after that."
Write-Host ""
