# IPFX Markets Desktop

## Scope and status

This is a real Electron desktop client for the existing HTTPS IPFX Markets platform, not a replacement trading engine.
Windows NSIS and macOS Apple Silicon/Intel DMG targets are configured.
Preview installers are unsigned and are for internal testing only. Never label them production-ready.
No signing keys, broker tokens, Supabase service keys or payment credentials are included.

The public download page intentionally has no installer links until signed artifacts exist.
Do not claim the desktop wrapper reduces quote latency or changes execution quality.

## Verified Windows preview

- Artifact: `dist/IPFX-Markets-UNSIGNED-PREVIEW-0.1.0-preview.1-win-x64.exe`
- Size: 111,474,087 bytes
- SHA-256: `183D9E020937CCDB327BEE8C342AEA289A8D14DB5FFEBAF93BAD4CAF6A1C0FD5`
- Status: unsigned internal preview; do not publish as a customer release
- Verified: nine policy/release tests, Electron runtime isolation and offline behavior, package allowlist, and Electron security fuses

The Windows checksum changes whenever the installer is rebuilt. Recalculate and update it before distributing any later artifact.

## Local commands

Requires Node.js 22+ and npm. Run from this directory:

- `npm ci`
- `npm test`
- `npm run test:runtime` (launches an isolated local fixture, never submits trades)
- `npm start`
- `npm run dist:win:preview` (Windows internal preview, unsigned)
- `npm run dist:win` (signed Windows release; fails without signing)
- `npm run dist:mac` (run on macOS; builds separate arm64 and x64 DMGs)

The icon is a raster export of the existing IPFX logo.
The persistent desktop profile is separate from the user's browser profile.
Users sign in independently in the desktop app using the Markets / Sign In menu.
Close and reload commands require confirmation and never submit close/cancel orders.

## Release prerequisites

1. Windows: an Authenticode signing identity controlled by IPFX (or approved cloud signing setup). Configure electron-builder's documented signing settings. Do not commit certificates or passwords.
2. Mac: Apple Developer ID Application signing certificate and Apple notarization credentials, plus a Mac build runner. Configure `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`, or the documented API-key alternative.
3. Verify Windows publisher signatures and macOS notarization/stapling. Test both Mac architectures on real machines. Windows x64 is the current Windows target; Windows ARM is not advertised.
4. Test first install, desktop/Start Menu shortcut, Applications-folder installation, upgrade, uninstall, saved login, password reset, session expiry, account selection, menus, chart resize, GPU fallback, sleep/wake, reconnect and exports.
5. Test open positions during disconnect, quit, reload and machine sleep. The desktop client never queues offline orders, but the current website/server must also be tested for retries and duplicate execution.
6. Test third-party chart licensing and all embedded origins. Popups and native permissions are denied by default; OAuth/popups/native notifications are not claimed supported in this preview.
7. Publish installers over HTTPS with version, architecture, sizes, SHA-256 checksums, release notes and minimum OS requirements verified against the actual build.
8. Replace disabled download controls only after those artifacts and tests exist.

## Security and updates

Remote pages have no Node integration, preload bridge or renderer-to-main IPC.
Context isolation, renderer sandbox and browser security remain enabled.
Top-level navigation is restricted to the exact IPFX HTTPS origin; certificate errors fail closed.
File exports are limited to report/image extensions and use a user-selected save destination.
The client contains no system-shell execution facility and never accepts arbitrary launch URLs.
Production packaging disables Electron's Node/inspection switches and requires ASAR integrity.
User account data stays in Electron's persistent per-user browser profile; this is not a claim that all localStorage data is encrypted at rest.
The preview has no unattended binary updates or forced restarts. Download/install newer signed releases explicitly.
Website content remains server-delivered and follows the website deployment, independently of the Electron binary version.
Keep Electron patched and maintain a tested release cadence before broad distribution.

## Design references

- TradeLocker Windows and separate Mac downloads: https://tradelocker.com/desktop/
- MetaTrader Mac compatibility installer: https://www.metatrader5.com/en/terminal/help/start_advanced/install_mac
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- electron-builder v26 packaging: https://www.electron.build/v26/docs/configuration/
- Signing/notarization: https://www.electron.build/v26/docs/mac/

## Restore point

The pre-desktop source snapshot is at `C:\Users\paula\IPFX-restore-points\pre-desktop-20260910-01`.
It excludes dependency/build caches. No database changes are required for this desktop client.
