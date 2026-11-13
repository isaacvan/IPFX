# IPFX on phones: plan and build prompt

Written 11 Nov 2026 after measuring the live pages at iPhone size (390 x 844) and reading Apple's and Google's current rules.
Paste the "Prompt" section into a new Claude Code session opened in this folder.

## What the research found

Measured at phone size (script: phone-audit, Playwright, real Chrome):

| Page | Controls too small to tap (<40px) | Inputs that make iPhone zoom (<16px text) | Controls off-screen | Text under 12px |
|---|---|---|---|---|
| Markets (trading.html) | 60 of 85 | 2 of 2 | 13 | 135 of 204 |
| Sign-up | 10 of 20 | 7 of 7 | 0 | 1 |
| Login | 8 of 14 | 2 of 2 | 0 | 0 |
| Start challenge | 9 of 13 | 0 | 0 | 0 |
| Home, Infinity | 2 | 0 | 0 | 3 |

- Markets is the broken page. The order panel stays 360px wide beside the chart, so on a 390px phone the chart is almost invisible. No page uses safe-area insets (notch / home bar).
- The chart already uses pointer events, so touch dragging can work. 128 hover-only styles and 3 double-click actions need a tap equivalent.
- site.webmanifest exists (standalone) but there is no service worker, no apple-touch-icon, and both icon sizes point at one file.
- Sign-in is email and password only (no Google sign-in), which is good: it works inside an app wrapper.
- 77% of users are phone-only and convert at 45%, against 66% on desktop.

Store rules (check the live pages again before paying for anything):

- Apple 4.2: an app must be more than a repackaged website. A plain wrapper is the most common rejection.
- Apple 3.2.1(viii) and 5.1.1(ix): trading and financial apps should be submitted by the company providing the service (a legal entity, not an individual), with any licences needed where the app is offered. IPFX must enrol as an organisation (needs a D-U-N-S number).
- Apple 2.1: a working demo login must be supplied to the reviewer.
- Apple 3.1.1: anything unlocked inside the app must use Apple's in-app purchase. So the iPhone app must not sell challenges or the monthly fee in version 1. Outside the US, linking out to buy is not allowed either.
- Apple 5.3: contests need official rules in the app saying Apple is not a sponsor.
- Google Play: a personal developer account created after 13 Nov 2023 must run a closed test with 12 testers for 14 days before going public. An organisation account avoids this in practice but also needs a D-U-N-S number. Any app with financial features must complete the Financial features declaration.
- iPhone home-screen web apps: no automatic install prompt (the page must show "Share, then Add to Home Screen"), push notifications only after install (iOS 16.4+).
- Building the iPhone app needs a Mac or a cloud Mac build service (this computer is Windows).

Sources: developer.apple.com/app-store/review/guidelines, support.google.com/googleplay/android-developer/answer/14151465, support.google.com/googleplay/android-developer/answer/9876821, developer.chrome.com/docs/android/trusted-web-activity, firt.dev/notes/pwa-ios.

## Plan

1. Phase 1 (days 1-4): phone layout for Markets. Chart on top, bottom tab bar (Chart, Trade, Positions, Account), order ticket as a bottom sheet with large Buy/Sell, stop-loss countdown always visible.
2. Phase 2 (day 5): sign-up, login, application and dashboard at phone size (16px inputs, 44px buttons, camera upload for ID).
3. Phase 3 (day 6): installable web app. Service worker, proper icons, install prompt on Android, "Add to Home Screen" guide on iPhone. This is the "download" that works for everyone on day 6.
4. Phase 4 (day 7 onward, depends on Apple and Google): store apps with Capacitor. Android first. iPhone needs the organisation account and a cloud Mac build. Version 1 sells nothing in the app.
5. Phase 5: push notifications (stop-loss warning, target reached, approval).

Success measures: phone-only first-trade conversion from 45% to 60% or more; Markets phone audit at 0 off-screen controls, 0 inputs under 16px, under 5 small tap targets; no horizontal scroll on any page.

## Prompt

You are a senior mobile product designer and front-end engineer working on IPFX Capital (static site, GitHub Pages, repo in this folder; Supabase back end; trading.html is the Markets platform with assets/js/markets-guided.js as the order ticket and assets/js/ipfx-chart.js as the chart). Read docs/MOBILE-APP-PROMPT.md first for the measurements and store rules.

Goal: make IPFX excellent on phones, then installable on iPhone and Android. Desktop must look and behave exactly as it does now.

Rules:
- All phone work goes behind `@media (max-width: 760px)` or a `phone` class set once on `<html>`. Do not change desktop CSS or desktop behaviour. Run the full test suite (`DEMO_TEST_DEPS=C:/Users/paula/AppData/Local/Temp/ipfx-demo-validation node --test tests/*.test.mjs`) before every push; it must stay at 0 failures.
- Another agent works in this same folder and deploys in parallel. Run `git fetch` and check `git status` before every commit, commit only your own files, never deploy Supabase functions for this work.
- Do not change trading rules, risk limits, order logic or any server code. This is layout and interaction only.
- Use plain English in every label. No em dashes in user-facing text.
- Every tap target at least 44 x 44 px. Every input at least 16px text. Use `env(safe-area-inset-*)` and `100dvh`. Add `viewport-fit=cover`. No horizontal scrolling at 360, 390 and 430 px wide.
- Every hover-only or double-click action needs a tap equivalent.

Phase 1, Markets on a phone (do this first, show screenshots before moving on):
1. Bottom tab bar: Chart, Trade, Positions, Account. One panel visible at a time. Chart is the default.
2. Trade opens the existing ticket (`#gtCard`) as a bottom sheet over the chart, with full-width Buy and Sell buttons, lot size steppers, and the stop-loss choice visible without scrolling.
3. The 30-second stop-loss countdown card and the three-strike warning must stay visible above the tab bar on every tab, with "Add stop" as a large button.
4. Positions: one card per trade (symbol, side, size, profit, stop), with Close and Edit stop as large buttons. No table.
5. Chart: pinch to zoom, drag to pan, long-press for the crosshair, timeframe picker as a horizontal strip. Trade lines draggable by finger with a larger grab area.
6. Top bar reduced to logo, symbol picker, balance. Everything else moves under Account.
7. Welcome tour and cookie banner must not cover each other on a phone.
8. Write a Playwright check (pattern: tests/markets-overnight-browser.test.mjs) at 390 x 844 asserting: no control off-screen, Buy and Sell at least 44px tall, ticket usable without horizontal scroll, countdown card visible with a no-stop trade open.

Phase 2: signup.html, login.html, start-challenge.html, dashboard.html at phone size. ID upload must offer the camera (`capture="environment"`). Keep every element id used by assets/js/checkout-flow.js.

Phase 3: installable web app. Add a service worker that caches only the static shell (never prices, never account data, never API calls), real 192 and 512 icons plus a maskable icon and apple-touch-icon, an Android install button using `beforeinstallprompt`, and an iPhone "Share, then Add to Home Screen" guide shown only in Safari when not installed. Replace the phone view of downloads.html with these.

Phase 4: store apps. Create `mobile/` with a Capacitor project that loads the bundled site, plus native push, a splash screen, biometric unlock and a share-your-progress card so it is more than a website wrapper. Version 1 has no purchase screens and no links to buy. Include the contest rules page stating Apple is not a sponsor, and a reviewer demo login. Android: build an .aab on this machine. iPhone: prepare the project and a cloud Mac build config; the owner signs in to Apple and Google themselves.

Stop and ask the owner before: creating any developer account, paying any fee, submitting to a store, or changing anything on the desktop layout.

After each phase report: what changed, screenshots at 390 px, the audit numbers before and after, and test results.
