# Team Login verification — 12 October 2026

The intended journey is normal sign-in → owner membership check → authenticator setup or code → requested Team page. A previously verified MFA session can return directly to Team after the membership check.

## Changes

- Reject backslashes and control characters in the normal login return URL. Browsers normalize those characters, so merely rejecting `//` did not prevent every external redirect.
- On unfinished authenticator setup, replace only unverified TOTP factors named `IPFX Team` before generating a fresh QR. Existing verified factors take precedence and are never removed. Pending factors belonging to other setups are preserved.
- Prevent simultaneous access retries from creating duplicate setup attempts.
- Check that successful verification really upgraded the session to `aal2`, then check owner membership again before redirecting.
- Show a recovery message when the authentication SDK fails to load or the session cannot be read. Distinguish service errors from incorrect authenticator codes.
- Use local sign-out on an owner membership denial, preserving sessions on other devices.

No backend functions, database policies, broker settings or challenge rules are changed.

## Evidence

- Live signed-out browser navigation preserved the requested Brain destination through `/login.html?next=...` and displayed the normal login form.
- Synthetic browser test using the actual Team page script: wrong code stayed on Security check and allowed a retry; correct code navigated to the requested Team destination. The fixture used no real credentials, authenticator secrets or production requests.
- 36 focused tests passed, including first setup, verified-factor login, abandoned-factor recovery, invalid codes, missing SDK, session errors, revoked membership, retry races, redirect safety and existing Team API authorization tests.
- Full `.test.mjs` baseline: 939 tests, 932 passed, 4 failed, 3 skipped. After changes: 955 tests, 948 passed, the same 4 failed, 3 skipped. The `.js` authentication UI tests are included in the focused run.
- Six live POST requests without an authentication header returned HTTP 401: `team-access`, `brain-monitor`, `team-population`, `treasury`, `e8-monitor-admin`, `ladder-admin`.
- Source review confirmed owner/admin checks on `team-access`, and server-side MFA requirements on Team data services. `team-access` intentionally permits the owner's first-factor session so the page can offer MFA setup; it does not grant Team data access by itself.

Existing suite failures: `ab-risk-missing-config` assertion; two document quota tests expecting 350 where source now specifies 450; sandbox filesystem rename restriction in `launch-risk-recovery`. These are not altered in this login change.

## Remaining live check

The owner must complete the normal password sign-in and authenticator step themselves. This audit does not claim a fresh real password-plus-MFA sign-in has succeeded. Confirm the requested Team page loads with real data after that step. Do not send passwords or authenticator codes in chat.

MFA lifecycle reference: [Supabase authenticator documentation](https://supabase.com/docs/guides/auth/auth-mfa/totp) and [enrollment API](https://supabase.com/docs/reference/javascript/auth-mfa-enroll). An enrollment creates an unverified factor; successful verification upgrades the session to `aal2`.
