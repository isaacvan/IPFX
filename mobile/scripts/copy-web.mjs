// Prepares the files the IPFX Markets app shows, and writes capacitor.config.json.
//
// Two modes (set IPFX_APP_MODE before running):
//   bundled (default)  The app carries its own copy of the trader pages from this folder. Use this to try the phone
//                      layout before the website is published. Prices, accounts and orders still go to the live IPFX
//                      servers, exactly as the website does.
//   live               The app opens https://ipfxcapital.com/trading.html, so every website release reaches the app at
//                      once. Use this after the phone layout is published.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const site = path.resolve(app, '..');
const www = path.join(app, 'www');
const mode = (process.env.IPFX_APP_MODE || 'bundled').toLowerCase();
if (!['bundled', 'live'].includes(mode)) throw new Error('IPFX_APP_MODE must be "bundled" or "live"');

// Trader-facing pages only (no team, admin or test pages inside the app).
const PAGES = ['trading.html', 'dashboard.html', 'login.html', 'signup.html', 'reset-password.html', 'email-confirmed.html',
  'start-challenge.html', 'infinity.html', 'infinity-v2.html', 'terms.html', 'privacy.html', 'risk-disclosure.html', 'faq.html',
  'contact.html', 'feedback.html', 'unsubscribe.html', 'markets-offline.html', '404.html'];
const FILES = ['markets.webmanifest', 'site.webmanifest', 'desktop/build/icon.png'];
const DIRS = ['assets', 'favicon', 'brand-logos', 'legal'];

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
const copy = (rel) => {
  const from = path.join(site, rel);
  if (!fs.existsSync(from)) return;
  const to = path.join(www, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};
for (const p of PAGES) copy(p);
for (const f of FILES) copy(f);
for (const d of DIRS) copy(d);
// The app starts on Markets.
fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IPFX Markets</title><script>location.replace("/trading.html?source=app")</script>');

const config = {
  appId: 'com.ipfxcapital.markets',
  appName: 'IPFX Markets',
  webDir: 'www',
  backgroundColor: '#0a0a0c',
  android: { backgroundColor: '#0a0a0c', allowMixedContent: false },
  ios: { backgroundColor: '#0a0a0c', contentInset: 'never' },
  plugins: {
    SplashScreen: { launchShowDuration: 600, backgroundColor: '#0a0a0c', showSpinner: false },
    StatusBar: { style: 'DARK', backgroundColor: '#0a0a0c', overlaysWebView: false },
  },
};
if (mode === 'live') {
  config.server = { url: 'https://ipfxcapital.com/trading.html?source=app', allowNavigation: ['ipfxcapital.com', 'www.ipfxcapital.com'] };
}
fs.writeFileSync(path.join(app, 'capacitor.config.json'), JSON.stringify(config, null, 2) + '\n');

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`IPFX Markets app: ${mode} mode, ${count(www)} files in www/`);
