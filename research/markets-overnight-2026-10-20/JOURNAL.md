# IPFX Markets overnight audit — 20 October 2026

## Authorization and operating window

Owner requested active overnight testing and fixing of IPFX Markets, including prior trader complaints. Heartbeat `ipfx-markets-overnight-bug-audit` resumes this chat every 15 minutes until 08:30 Europe/London (07:30 UTC), or until the owner stops it. Work from this repository, fetch current main, preserve concurrent changes and use isolated product tests or disposable demo only. Do not access credentials, send messages/emails, place live/funded/challenge orders, edit financial history, or change risk/challenge/Terms rules. The Books rollout's one-task key exception has ended.

Browser-control inventory returned `Local browser use is disabled in Work settings`. No alternate access to the owner's browser was attempted. Browser verification uses a separate disposable Chromium process, actual Markets HTML/CSS and extracted actual order/tour functions, with synthetic authentication, prices, responses and all external requests blocked. It does not establish signed-in production behavior.

## First pass: confirmed reproductions

Started from main f047395 on branch `codex/markets-overnight-2026-10-20`. Registered ten behavioral reproductions in `tests/markets-overnight-actions.test.mjs`: all ten failed against the original source. Added fill-feedback and cross-account confirmation regressions while implementing the fixes.

1. A late state response overwrote a newer account snapshot. Added issued/applied sequence tracking for full snapshots.
2. Account mode was chosen after awaiting session refresh: a click in Demo could be sent to Challenge if mode changed during that await. Snapshot request context synchronously and cancel unsent work when context changes. A context epoch also distinguishes a switch away and back.
3. A reply from the previous account could replace the newly selected account. Old-context replies preserve their action acknowledgement but cannot replace the displayed account or apply its lockout to the new account. Existing breached-order refusals still return failure and show the warning in their own context.
4. Authentication ran outside the request deadline/error handler. A hung refresh could leave trading buttons busy indefinitely. Include session acquisition in the abort deadline, catch auth failures, and report accurately when nothing was sent. Only actually dispatched requests carry the existing uncertain-outcome warning.
5. Close timeout was 60 seconds but the message said 15. Report the correct deadline.
6. Reverse chose the last account position, even if it belonged to another market. Select a position only on the displayed market; an empty market no longer silently opens a buy.
7. Reverse could open the new direction after a `closing:true` acknowledgement while the original position remained open. Require the original position to disappear from confirmed account state. Do not automatically resubmit after an uncertain/pending close.
8. Reverse could continue on a different account/market after waiting for close. Verify the original context before its second leg.
9. Close All reported “All positions closed” when the server returned open positions. Report the remaining count or an unconfirmed snapshot explicitly.
10. Order success labels used the current ticket's symbol/volume after awaiting the request. Use the submitted payload's symbol/volume and symbol-specific price precision. A pending acknowledgement cannot clear a newly edited different-market ticket.
11. Close All's short-hold confirmation could outlive an account switch and close the new account's positions. Bind confirmation to the original account/mode and cancel on change.

## Verification and deployment

Initial focused regression group: 38 passed after one fix to preserve breach warnings on HTTP 409. Extended group includes fill-label and account-confirmation cases. Browser fixture initially omitted actual lot-input handlers; corrected the fixture to include those production functions instead of manually setting lots. This was a harness omission, not a platform bug. Full suite and isolated desktop browser tests are running; record exact final counts and published commit below before claiming live fixes.

First-pass validation completed: 40 targeted regressions passed, zero failures/skips. Two actual-HTML desktop browser tests passed, including retained manual lots, actual submitted stop, stale-price click refusal and all four instant tour dismissal routes with saved seen state/manual replay. Full repository suite passed: 1,194 passed, zero failed, nine optional skipped (1,203 total). The full suite started before the final close-all confirmation regression was added; the final focused group explicitly covers that latest change. No source was changed to weaken a failing test. Publication pending the concurrent-source check.

First repair batch published as f550ef3 after fetch/ancestor checking. Live `/trading.html` initially returned the old HTML during Pages propagation, then returned 200 with the account-context and Reverse fixes. No edge or database deployment was needed.

Second pass: added a regression for an older lockout payload arriving after a newer unlocked snapshot. Apply the same issued/applied snapshot guard to lockout fields as to account state. Added failing precision fixtures: EURUSD's old step rounded five-decimal stops to cents, while JPY/silver introduced a fourth decimal. Spot SL/TP steps now use one displayed quote tick at `pxDigits(activeSym)`; futures retain their existing behavior pending separate tick-spec audit. Five symbol round-trip checks pass (EURUSD, USDJPY, XAGUSD, XAUUSD, DJI). Updated actual-HTML browser tests exercise the real SL stepper and its guided-ticket input event. Latest focused group 42 passed; both desktop browser tests passed. Second full suite is running before publishing these follow-ups.

Second-pass release checks: full suite 1,196 passed, zero failed, nine optional skipped (1,205 total); final focused group grew to 44 passing cases with actual account-selector away/back and pending-ticket preservation checks. Two desktop browser tests passed after exercising the real spot stepper. Production HTML matched origin/main f550ef3 exactly before publication. Aggregate complaint audit read counts only: three feedback submissions, all mention size/stop controls and one mentions closing. This tiny, overlapping keyword count is prioritization evidence, not a comprehensive complaint survey; no customer messages/emails were printed or committed. No credentials were retrieved.

Second batch published as 44119d1. After Pages propagation, live `/trading.html` returned 200 and matched the complete reviewed local HTML exactly, including both precision and lockout snapshot fixes. Working branch now tracks origin/main and is clean after this audit record. Continue with the next outstanding matrix row on the scheduled follow-up; the overnight audit is ongoing, not a claim that all possible bugs have been excluded.

## Third pass: position-management confirmations

Heartbeat at 00:56 UTC; fetched main 7c7cbd3 with no concurrent changes. Reproduced eight failing behavioral cases in the actual `omSubmit`/dialog functions (plus one passing valid-action control). The first fixture omitted the browser's automatic string conversion for input values; fixed that harness before recording the eight product failures.

- A short-hold partial-close confirmation could survive an account switch, a position resize/closure, or a closed/replaced dialog. Bind the dialog to its account ID, account mode and selector epoch; recheck the original position and volume after confirmation. Account switches away and back also invalidate the dialog.
- Repeated clicks created overlapping confirmations and could dispatch duplicate partial closes. Reserve the dialog's submit state before awaiting confirmation and recheck the global action lock before dispatch. Release only the lock this operation acquired.
- Late replies relabelled/closed a newer dialog or attached an old error to it. Capture dialog identity and mode; only update the originating dialog while its context is current.
- A missing management acknowledgement was labelled “rejected,” contradicting the engine's uncertain-outcome warning. Tell the trader to check positions/history before retrying.
- Management price labels formatted another market's entry using the currently selected market's precision. Pass the position's own symbol to the existing formatter.

Focused management/action/feedback/duplicate-close group: 35 passed. New management coverage includes valid modify, trailing-off and partial-close payloads, and confirms that an unrelated action's busy lock is retained. Full suite and actual-HTML partial-close interaction tests are running; publication pending their results and concurrent-source comparison. No broker, live/funded/challenge account or credential access occurred; the isolated fixture is synthetic.

Third-pass release checks: full suite 1,207 passed, zero failed, ten optional skipped (1,217 total). The initial new browser interaction timed out while the broader suite was also running; no product error or cause was captured. Added bounded Playwright waits and failure-state diagnostics. The partial-close test then passed alone, followed by all three desktop browser tests passing together (zero failures/skips, ~17 seconds), without further production changes. The actual warning dialog was used: a changed account sent zero requests; a fresh confirmed 0.05-lot slice sent exactly one synthetic request and closed the originating management dialog. Signed-in production interactions remain untested because owner browser control is disabled.

Before publication, fetched main again: still 7c7cbd3, no divergence; live HTML returned 200 and matched that baseline exactly. Reviewed the diff: frontend context/submit guards, price formatting and honest acknowledgement text only. No layout, financial rules, execution pricing, broker transport or performance architecture changed. Publication commit and live verification follow below.

## Resume instructions

Read TEST_MATRIX.md. Finish the current publication if pending, inspect git and log evidence, then rotate to the next untested area. Avoid rerunning identical passing broad suites without changed production risk. Follow fetch/diff/three-way preservation before publication; these first fixes are frontend-only, so no edge deployment or privileged keys are needed. Record subsequent findings and limits here, then update the matrix.
