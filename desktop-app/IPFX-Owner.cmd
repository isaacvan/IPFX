@echo off
REM ============================================================
REM  IPFX Owner - desktop launcher
REM  Opens the owner performance board (admin.html) in its own
REM  chromeless app window with a persistent login profile, so it
REM  behaves like a native desktop app and you stay signed in.
REM
REM  URL and browser can be overridden with env vars if needed:
REM    set IPFX_OWNER_URL=https://ipfxcapital.com/admin.html
REM ============================================================
setlocal

if "%IPFX_OWNER_URL%"=="" set "IPFX_OWNER_URL=https://ipfxcapital.com/admin.html"

REM Dedicated profile dir so the owner session persists and is kept
REM separate from the user's normal browsing profile.
set "IPFX_PROFILE=%LOCALAPPDATA%\IPFXOwner\profile"
if not exist "%IPFX_PROFILE%" mkdir "%IPFX_PROFILE%" >nul 2>&1

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" --app="%IPFX_OWNER_URL%" --user-data-dir="%IPFX_PROFILE%" --window-size=1200,900
  goto :eof
)
if exist "%CHROME1%" (
  start "" "%CHROME1%" --app="%IPFX_OWNER_URL%" --user-data-dir="%IPFX_PROFILE%" --window-size=1200,900
  goto :eof
)
if exist "%CHROME2%" (
  start "" "%CHROME2%" --app="%IPFX_OWNER_URL%" --user-data-dir="%IPFX_PROFILE%" --window-size=1200,900
  goto :eof
)

REM No Chromium browser found: open in the default browser as a fallback.
start "" "%IPFX_OWNER_URL%"
endlocal
