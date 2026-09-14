@echo off
REM ============================================================
REM  IPFX Owner - desktop launcher
REM  Opens the owner performance board (admin.html) in its own
REM  chromeless app window using your DEFAULT browser profile, so
REM  it uses the same network/proxy path (and existing login) as
REM  your normal browsing. An isolated --user-data-dir was found to
REM  time out on this machine while the default profile reaches the
REM  site fine.
REM
REM  Override the URL if needed:
REM    set IPFX_OWNER_URL=https://www.ipfxcapital.com/admin.html
REM ============================================================
setlocal

if "%IPFX_OWNER_URL%"=="" set "IPFX_OWNER_URL=https://ipfxcapital.com/admin.html"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"

if exist "%EDGE%" (
  start "" "%EDGE%" --app="%IPFX_OWNER_URL%" --window-size=1200,900
  goto :eof
)
if exist "%CHROME1%" (
  start "" "%CHROME1%" --app="%IPFX_OWNER_URL%" --window-size=1200,900
  goto :eof
)
if exist "%CHROME2%" (
  start "" "%CHROME2%" --app="%IPFX_OWNER_URL%" --window-size=1200,900
  goto :eof
)

REM No Chromium browser found: open in the default browser as a fallback.
start "" "%IPFX_OWNER_URL%"
endlocal
