# Try the new phone version of IPFX Markets on your own phone, without publishing anything.
#
# Your PC serves the trader pages over your home Wi-Fi only. Your phone must be on the same Wi-Fi.
# Prices, sign-in and trades use the real IPFX servers, exactly like the website.
# Windows may ask whether Python can use private networks: choose Allow (private networks only).
# Close this window (or press Ctrl+C) to stop.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8940

Push-Location $here
try { node scripts/copy-web.mjs } finally { Pop-Location }

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Sort-Object -Property InterfaceMetric | Select-Object -First 1).IPAddress
if (-not $ip) { Write-Host 'Could not find this PC''s Wi-Fi address. Check you are connected to Wi-Fi.' -ForegroundColor Red; exit 1 }
$url = "http://${ip}:${port}/trading.html"

# A page on this PC with a QR code to scan with the phone's camera.
$qr = Join-Path $env:TEMP 'ipfx-phone-preview.html'
@"
<!doctype html><meta charset="utf-8"><title>Open IPFX Markets on your phone</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0c;color:#f4f4f5;font:18px/1.5 system-ui,sans-serif;text-align:center}#qr{background:#fff;padding:18px;border-radius:16px;display:inline-block;margin:18px 0}code{font-size:20px;color:#93c5fd}</style>
<div><h1>Scan with your phone's camera</h1><div id="qr"></div><p>or type <code>$url</code></p>
<p>iPhone: in Safari tap Share, then <b>Add to Home Screen</b>.<br>Android: in Chrome tap the menu, then <b>Add to Home screen</b>.</p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById('qr'),{text:'$url',width:280,height:280});</script>
"@ | Set-Content -Encoding UTF8 $qr
Start-Process $qr

Write-Host ''
Write-Host "  Open on your phone:  $url" -ForegroundColor Cyan
Write-Host '  (same Wi-Fi as this PC). Close this window to stop.' -ForegroundColor Gray
Write-Host ''
python -m http.server $port --bind $ip --directory (Join-Path $here 'www')
