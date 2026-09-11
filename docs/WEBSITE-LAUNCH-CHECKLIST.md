# Website launch checklist

Last reviewed: 11 September 2026

| # | Item | Status | Implementation / launch dependency |
|---:|---|---|---|
| 1 | Privacy policy | Complete as a launch draft | `privacy.html` reflects IPFX Markets, consent-gated analytics, and aggregate/anonymised trading-data use. Qualified UK legal review is required before paid launch. |
| 2 | Terms page | Complete as a launch draft | `terms.html` is linked throughout the site and aligned with IPFX Markets. Add verified company registration and registered-office details after incorporation details are confirmed. |
| 3 | Clear CTA | Complete | Homepage and product pages use direct account/challenge actions with descriptive link text. |
| 4 | FAQ | Complete | Dedicated `faq.html`, accessible accordion behaviour, current 85/15 split and IPFX Markets wording. |
| 5 | robots.txt | Complete | Allows public crawling and declares the sitemap. |
| 6 | sitemap.xml | Complete | Includes public pages, downloads, and the risk disclosure page. |
| 7 | Custom 404 | Complete | Branded `404.html` with routes back into the site. |
| 8 | Alt text | Complete | Public-page images are checked for alt attributes; decorative images use empty alt text where appropriate. |
| 9 | Analytics | Integration ready | Analytics is disabled until consent and loads only from `window.IPFX_ANALYTICS`. Configure the production analytics provider, site ID/domain, and privacy settings before expecting data. |
| 10 | Meta titles | Complete | Every audited public page has a unique, descriptive title. |
| 11 | Meta descriptions | Complete | Every audited public page has a page-specific description. |
| 12 | Social share | Complete | Open Graph and Twitter metadata are present, and each launch footer has a Share control with native-share, clipboard, and manual-copy fallbacks. |
| 13 | Favicon | Complete | Favicon and web-manifest assets are referenced across audited public pages. |
| 14 | Canonical URLs | Complete | Audited public pages declare canonical `https://ipfxcapital.com/` URLs. |
| 15 | Cookie consent | Complete | Essential storage is explained; optional analytics stays off until accepted; preferences can be reopened from the footer. |
| 16 | Mobile version | Complete | Desktop and mobile browser checks pass without horizontal overflow across the audited public pages. |
| 17 | Accessibility | Complete for automated launch checks | Skip link, main landmark fallback, labelled controls, keyboard FAQ behaviour, live announcements, and focus behaviour are included. Conduct a manual keyboard and screen-reader pass before launch. |
| 18 | Test forms | Complete for current integrations | Contact and account forms retain their existing Supabase flow. Newsletter no longer reports false success; it submits only when `window.IPFX_NEWSLETTER_ENDPOINT` is configured. |
| 19 | Check broker/platform links | Complete | Public links and local routes are audited. The supported platform copy now consistently names IPFX Markets; the official TradingView sign-in link is retained. Unverified Trustpilot claims and links were removed. |
| 20 | Automated launch QA | Complete | Run `node scripts/website-launch-audit.mjs`; it checks metadata, canonical URLs, icons, headings, social tags, alt text, forms, local links, robots, sitemap, sharing, and platform terminology. |

## Required owner inputs before paid public launch

1. Have a qualified UK lawyer approve `privacy.html`, `terms.html`, and `risk-disclosure.html` and supply the final company registration and registered-office details.
2. Configure `window.IPFX_ANALYTICS` if analytics is wanted, and verify its consent/cookie settings in production.
3. Configure `window.IPFX_NEWSLETTER_ENDPOINT` if newsletter collection is wanted.
4. Replace preview download destinations only after Windows and macOS installers are signed and release-tested.
