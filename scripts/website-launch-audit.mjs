import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const publicPages=['index.html','about.html','backtest.html','contact.html','faq.html','futures.html','infinity.html','personalised-challenge.html','press.html','privacy.html','start-challenge.html','terms.html','trading-pot.html','downloads.html','risk-disclosure.html'];
const failures=[];let checks=0;
function ok(value,message){checks++;if(!value)failures.push(message)}
function read(file){return fs.readFileSync(path.join(root,file),'utf8')}
for(const file of ['privacy.html','terms.html','faq.html','robots.txt','sitemap.xml','404.html','assets/images/favicon.ico',...publicPages])ok(fs.existsSync(path.join(root,file)),`${file}: missing`);
for(const file of publicPages){
 const html=read(file);
 ok(/<html\b[^>]*\blang=["']en["']/i.test(html),`${file}: missing English language`);
 ok(/<meta\b[^>]*name=["']viewport["']/i.test(html),`${file}: missing viewport`);
 ok(/<title>\s*[^<]+\s*<\/title>/i.test(html),`${file}: missing title`);
 ok(/<meta\b[^>]*name=["']description["'][^>]*content=["'][^"']{40,}["']/i.test(html),`${file}: missing useful meta description`);
 ok(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']https:\/\/ipfxcapital\.com\//i.test(html),`${file}: missing canonical URL`);
 ok(/<link\b[^>]*rel=["'][^"']*icon/i.test(html),`${file}: missing favicon`);
 ok((html.match(/<h1\b/gi)||[]).length===1,`${file}: expected one h1`);
 ok(/property=["']og:title["']/i.test(html),`${file}: missing Open Graph title`);
 ok(/name=["']twitter:card["']/i.test(html),`${file}: missing X/Twitter card`);
 ok(html.includes('/assets/css/site-foundation.css'),`${file}: shared accessibility styles missing`);
 ok(html.includes('/assets/js/site-foundation.js'),`${file}: shared consent/accessibility script missing`);
 ok(html.includes('data-ipfx-share'),`${file}: share control missing`);
 for(const tag of html.match(/<img\b[^>]*>/gi)||[])ok(/\balt\s*=/.test(tag),`${file}: image missing alt text: ${tag.slice(0,100)}`);
 for(const tag of html.match(/<a\b[^>]*target=["']_blank["'][^>]*>/gi)||[]){ok(/rel=["'][^"']*noopener/i.test(tag)&&/rel=["'][^"']*noreferrer/i.test(tag),`${file}: external new-tab link missing rel protection`)}
 for(const m of html.matchAll(/href=["']([^"']+)["']/gi)){
  const href=m[1]; if(!href||href.startsWith('#')||/^(https?:|mailto:|tel:|javascript:|data:)/i.test(href))continue;
  const local=href.split(/[?#]/)[0].replace(/^\//,''); if(local)ok(fs.existsSync(path.join(root,local)),`${file}: broken local link ${href}`);
 }
}
const siteJs=read('assets/js/site-foundation.js');
ok(siteJs.includes('CONSENT_KEY')&&siteJs.indexOf('saveConsent')<siteJs.indexOf('loadAnalytics();\n    panel.hidden'), 'analytics is not consent-gated');
ok(siteJs.includes('navigator.share')&&siteJs.includes('navigator.clipboard'), 'share fallbacks incomplete');
const robots=read('robots.txt');ok(robots.includes('Sitemap: https://ipfxcapital.com/sitemap.xml'),'robots.txt missing sitemap');ok(robots.includes('Disallow: /dashboard.html')&&robots.includes('Disallow: /trading.html'),'robots.txt exposes private application routes');
const sitemap=read('sitemap.xml');for(const file of publicPages)ok(sitemap.includes(file==='index.html'?'https://ipfxcapital.com/':`https://ipfxcapital.com/${file}`),`sitemap missing ${file}`);
const notFound=read('404.html');ok(/name=["']robots["'][^>]*noindex/i.test(notFound),'404 page must be noindex');
const all=publicPages.map(read).join('\n');ok(!all.includes("IPFX supports **MT4, MT5 and cTrader**"),'outdated MetaTrader/cTrader support claim remains');ok(!all.includes('evaluations with MT5'),'outdated MT5 evaluation claim remains');ok(!read('privacy.html').includes('MetaApi / broker connections'),'privacy page conflicts with terms on broker mirroring');ok(read('trading.html').includes("https://www.tradingview.com/signin/"),'official TradingView sign-in link missing');
ok(read('index.html').includes('id="newsletterForm"')&&read('index.html').includes('IPFX_NEWSLETTER_ENDPOINT'),'newsletter form lacks explicit provider state');
ok(read('backtest.html').includes('async function submitBacktest'),'backtest form handler missing');ok(read('start-challenge.html').includes('payDemoNotice'),'checkout lacks honest unavailable state');
if(failures.length){console.error(`FAIL: ${failures.length} of ${checks} checks failed`);for(const f of failures)console.error(`- ${f}`);process.exit(1)}
console.log(`PASS: ${checks} website launch checks`);
