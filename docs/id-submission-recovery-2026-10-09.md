# ID submission recovery — 9 October 2026

Owner reported a generic document-submission failure after upload, and mandatory expiry blocking national IDs without an expiry date.

- National ID applicants may explicitly declare that no expiry date is printed on the document. Store `id_has_no_expiry:true` and a null date, not a fabricated future date. Passport/driving licence and expired-dated IDs remain date-validated. Show the declaration in the owner application queue; it is not verification or approval.
- Both application/dashboard upload flows cache completed uploads only in the current page memory, bound to the current signed-in user and selected file. A retry reuses the same private path, including a partial batch. No file bytes/paths are persisted or logged.
- Bounded transient retries reuse the same document list. Document registration is serialised by user and ignores already-registered identical paths. Auth/ownership/file/expiry failures remain rejected with useful user messages.
- Migration20261009184531 preserves private-storage existence/ownership checks, current legal acceptance, reset gates, existing verified status and manual review. Do not repeat the global reset, alter the named applicant exemption, approve applicants or access real identity documents during verification.
-37focused tests passed, including actual deployed application definitions in isolated PostgreSQL, retry upload counts, checkbox/date switching, privacy/consent and source syntax. Hosted rollback rehearsal succeeded. Initial migration number20261009180000 collided with an existing access index and rolled back; the corrected number was applied successfully. No applicant data was changed.

The original generic screenshot has no RPC error code. The previously deployed standalone KYC function succeeds in an isolated valid-file fixture; this does not establish the original customer's failure cause. These fixes repair confirmed expiry/retry/idempotency defects and expose actionable errors. Do not claim every possible external network/session/storage fault was diagnosed or eliminated.

Deployment evidence and public hashes are in the chat workspace `document-submit-fix/RESULT.md` and `public-verification.json`. Preserve concurrent main changea950bea (Infinity preselected on arrival). No credentials or real identity files were read.
