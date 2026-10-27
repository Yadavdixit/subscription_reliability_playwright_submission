# Risk-based test strategy

## Scope and assumptions

Black-box tests exercise the supplied HTTP API and observe persisted state through the debug endpoints. The source `server.py` is copied unchanged. `PENDING` is the initial application state; provider `SUCCESS` maps to application `ACTIVE`. Once `ACTIVE`, stale events must not downgrade it. The assignment says a user may have only one live trial per plan; the current API does not document what happens when a trial is terminal, so tests focus on duplicate live trials.

## Priority model

- **P0 — release blocker:** payment/subscription state can be corrupted, forged, duplicated, or downgraded; duplicate live trials under concurrency; authorization bypass on payment callbacks.
- **P1 — high:** reconciliation cannot recover a valid provider success; repeated payment records; invalid money input; transaction identity collisions; unexpected unknown-order state changes.
- **P2 — normal:** request validation, supported plans, health endpoint, response shape, diagnostics and operational usability.

## Highest-risk scenarios

| Area | Core scenarios and assertions | Priority |
|---|---|---|
| Trial creation | Monthly/yearly happy path; positive integer paise; reject zero/negative/bool; unknown plan and blank user; persisted row matches response | P0/P2 |
| Retry/idempotency | Repeat same create request; assert only one live user+plan trial | P0 |
| Concurrency | Barrier-synchronised requests for same user+plan; assert exactly one live row, all responses are safe and no database errors | P0 |
| Webhook security | Missing/wrong signature returns 401 and leaves trial/payment tables unchanged | P0 |
| Webhook state machine | SUCCESS activates; FAILED/PENDING behave as documented before success; stale FAILED/PENDING after ACTIVE cannot downgrade | P0 |
| Callback idempotency | Repeat identical callback; one logical payment and stable subscription state | P0 |
| Payment identity | Same `provider_txn_id` retry does not duplicate; transaction ID cannot be associated with a second payment/order | P1 |
| Unknown order | Callback creates neither payment nor trial state | P1 |
| Reconciliation | Internal key required; PENDING and FAILED can recover on provider SUCCESS; ACTIVE never downgrades; retries are idempotent | P0/P1 |
| Data integrity | Assert trial count/status/amount and payment count/transaction/status via debug API; inspect SQLite constraints/indexes where useful | P0/P1 |

## Automation vs. manual

Automate deterministic API contracts, state transitions, authorization, retries, data assertions and concurrency regression tests. Keep exploratory provider sandbox testing, real delivery delays, signature/key rotation, operational runbooks, load/soak tests, migration review and incident-response drills as manual or separate environment-level checks. Do not claim a local threaded smoke test proves production-scale concurrency.

## Isolation and reliability

The suite launches the bundled API on its documented local port and resets SQLite before each test using the authenticated reset endpoint. Each test uses unique user/order/transaction identifiers where appropriate. The concurrency test uses a barrier rather than sleeps to increase overlap. The suite uses bounded HTTP timeouts and fails if the server does not become healthy. Tests are black-box and do not patch implementation code. The reset endpoint deletes/recreates the local DB, so do not point this suite at shared or production data.

## Production monitoring

Track trial creation attempts vs. unique live trials; provider status vs. application status; time from provider SUCCESS to ACTIVE; webhook request/401/4xx/5xx rates; duplicate event and transaction-ID rates; reconciliation attempts, recoveries, age of unresolved PENDING records, and reconciliation failures; SQLite/database lock or write errors; and end-to-end payment activation latency. Alert on sustained provider SUCCESS/application non-ACTIVE mismatches, rising stale PENDING age, duplicate live trials, and signature failures beyond baseline.


## Additional API validation added in the Playwright version

- malformed JSON must return `400` and create no trial;
- missing required `amount` must return `400` and create no trial;
- invalid webhook status must return `400` and create no payment/state change;
- conflicting SUCCESS events for the same order must not create a second payment.

## Automation stack

- Node.js + Playwright Test
- Playwright `APIRequestContext` for REST API automation
- The supplied `server.py` remains unchanged and is launched automatically by Playwright when `QA_BASE_URL` is not set.
