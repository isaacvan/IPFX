# Adaptive mirror risk and trader analytics

This release classifies platform behaviour into scalper, news-event trader,
swing trader, high-frequency trader, or unclassified. The label is evidence,
not a disciplinary decision. It never changes a trader's challenge account.

The copy policy controls only IPFX's own mirrored account:

- `observe`: record the recommendation and copy at the configured base size.
- `adaptive`: reduce unusual/news-exposed copies and skip severe risk flags.
- `blocked`: do not open new copies.
- Close orders always pass through, in every mode.

## Production activation

1. Apply `supabase/migrations/20260918190000_adaptive_mirror_risk_and_trader_styles.sql`.
2. Set Edge Function secrets:
   - `IPFX_OWNER_EMAIL=paulade491@gmail.com`
   - `TRADING_ECONOMICS_API_KEY=<licensed key>`
   - `INTERNAL_CRON_SECRET=<new random 32+ byte value>`
3. Deploy `admin-console`, `live-mirror`, and `macro-calendar-sync`.
   Deploy `macro-calendar-sync` without JWT verification because it authenticates
   the scheduler using `x-internal-secret`; the other two retain their current
   authentication settings.
4. Store the same cron secret in Supabase Vault as
   `ipfx_macro_calendar_cron_secret`, then run `setup-macro-calendar-cron.sql`.
5. Publish `trader-analytics.html` and the updated `admin.html`.
6. Open `/team-login.html`, sign in as the configured owner and complete the
   authenticator step. Team Login then opens the private analytics page. Leave
   policies in `observe` until the evidence for each trader has been reviewed;
   enable `adaptive` individually.

The calendar API key and scheduler secret are server-side only. The browser
receives normalized event evidence and decisions, never provider credentials.
