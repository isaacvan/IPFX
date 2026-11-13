# Builds the IPFX Markets Android app (an .apk you can install on your own Android phone).
# Nothing is published: the file is saved to your Desktop as IPFX-Markets.apk.
#
# First run only: downloads Java (Eclipse Temurin 21) and the Android build tools into
#   %USERPROFILE%\ipfx-android-tools   (about 1.5 GB in total; delete that folder to remove them)
# and shows Google's Android SDK licence for YOU to read and accept. The build cannot continue without it.
#
#   -Mode bundled  (default) the app carries the phone pages from this folder; use before the website is published
#   -Mode live     the app opens https://ipfxcapital.com/trading.html; use once the phone layout is live on the website
param([ValidateSet('bundled', 'live')][string]$Mode = 'bundled')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tools = Join-Path $env:USERPROFILE 'ipfx-android-tools'
$jdk = Join-Path $tools 'jdk'
$sdk = Join-Path $tools 'sdk'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }

# 1. Java 21
if (-not (Test-Path (Join-Path $jdk 'bin\java.exe'))) {
  Step 'Downloading Java 21 (Eclipse Temurin)'
  $zip = Join-Path $tools 'jdk.zip'
  Invoke-WebRequest 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse' -OutFile $zip
  $tmp = Join-Path $tools 'jdk-tmp'; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp
  Move-Item (Get-ChildItem $tmp | Select-Object -First 1).FullName $jdk
  Remove-Item $tmp, $zip -Recurse -Force
}
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

# 2. Android command-line tools
$sdkmanager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
  Step 'Downloading the Android command-line tools'
  $zip = Join-Path $tools 'cmdline-tools.zip'
  try {
    Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip' -OutFile $zip
  } catch {
    Write-Host 'Download failed. Get "Command line tools only" for Windows from https://developer.android.com/studio,' -ForegroundColor Yellow
    Write-Host "save it as $zip and run this script again." -ForegroundColor Yellow
    exit 1
  }
  $tmp = Join-Path $tools 'clt-tmp'; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive $zip $tmp
  New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
  Move-Item (Join-Path $tmp 'cmdline-tools') (Join-Path $sdk 'cmdline-tools\latest')
  Remove-Item $tmp, $zip -Recurse -Force
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

# 3. Licence (you read and accept it) and SDK packages
if (-not (Test-Path (Join-Path $sdk 'licenses\android-sdk-license'))) {
  Step 'Android SDK licence: read it, then type y and press Enter for each one to accept'
  & $sdkmanager --sdk_root=$sdk --licenses
  if (-not (Test-Path (Join-Path $sdk 'licenses\android-sdk-license'))) { Write-Host 'The licence was not accepted, so the app cannot be built.' -ForegroundColor Yellow; exit 1 }
}
if (-not (Test-Path (Join-Path $sdk 'platforms\android-36'))) {
  Step 'Installing Android 16 (API 36) build packages'
  & $sdkmanager --sdk_root=$sdk 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'
}

# 4. Build
Step "Building the app ($Mode mode)"
Push-Location $here
try {
  if (-not (Test-Path 'node_modules')) { npm install --no-audit --no-fund }
  $env:IPFX_APP_MODE = $Mode
  node scripts/copy-web.mjs
  npx cap sync android
  Set-Content -Path 'android\local.properties' -Value ('sdk.dir=' + ($sdk -replace '\\', '\\'))
  Push-Location android
  try { .\gradlew.bat assembleDebug --no-daemon } finally { Pop-Location }
} finally { Pop-Location }

$apk = Join-Path $here 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $apk)) { Write-Host 'The build did not produce an app file. Scroll up for the error.' -ForegroundColor Red; exit 1 }
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'IPFX-Markets.apk'
Copy-Item $apk $out -Force
Step 'Done'
Write-Host "Your Android app is on the Desktop: $out" -ForegroundColor Green
Write-Host 'Put it on your Android phone (email it to yourself, Google Drive, or a USB cable), open it, and allow'
Write-Host '"Install unknown apps" for the app you opened it from when Android asks. This test build is for your own phone only.'
