# Animall QA Engineer Take-Home — Subscription Reliability

This submission uses **JavaScript + Playwright Test** for API automation. I selected Playwright because it provides a clean API testing layer through `APIRequestContext`, while also fitting my existing JavaScript automation experience.

## Important

`server.py` is the supplied challenge application and is included only to make the submission self-contained. **It has not been modified to make tests pass.**

The challenge application intentionally contains defects. Therefore, the full suite is expected to contain failing contract tests; those failures are defect evidence and are documented in `BUGS.md` and `TEST_RESULTS.md`.

## Prerequisites

- Python 3.9+
- Node.js 18+ recommended

## Install

```bash
npm install
npx playwright install
```

No browser is required for these API tests, but installing Playwright's browsers is harmless. If desired, `npm install` is sufficient for the API-only suite.

## Run the complete suite

From the project root:

```bash
npm test
```

Playwright automatically starts the supplied API server with:

```bash
python server.py --reset
```

on Windows, or:

```bash
python3 server.py --reset
```

on Linux/macOS.

The configuration automatically chooses `python` on Windows and `python3` elsewhere.

## Run by priority

```bash
npm run test:p0
npm run test:p1
```

## Open the HTML report

After a run:

```bash
npm run report
```

## Run against an already-running server

If the server is already running at `http://127.0.0.1:18080`:

### Windows PowerShell

```powershell
$env:QA_BASE_URL="http://127.0.0.1:18080"
npm test
```

### macOS/Linux

```bash
QA_BASE_URL=http://127.0.0.1:18080 npm test
```

## Test isolation

Every test calls:

```text
POST /api/admin/reset
X-Internal-Key: qa-internal
```

before execution. This prevents data created by one test from affecting another test.

## Coverage summary

The suite contains **40 meaningful API contract tests** covering:

- health check
- monthly/yearly trial creation
- invalid plan
- blank user
- zero/negative amount
- boolean amount
- float amount
- string amount
- malformed JSON
- missing required field
- duplicate trial requests
- concurrent trial creation
- missing webhook signature
- invalid webhook signature
- SUCCESS webhook
- FAILED webhook
- PENDING webhook
- unknown order
- duplicate SUCCESS webhook
- out-of-order FAILED webhook
- out-of-order PENDING webhook
- invalid webhook status
- conflicting duplicate SUCCESS events
- concurrent webhooks for same order
- FAILED → SUCCESS webhook recovery path
- reconciliation of PENDING
- reconciliation of FAILED
- reconciliation must not downgrade ACTIVE
- reconciliation authorization
- reconciliation idempotency
- reconciliation unknown order
- provider transaction ID reuse
- GET /api/subscriptions happy path
- GET /api/subscriptions 404 for unknown user
- GET /api/subscriptions reflects ACTIVE after webhook
- same user with different plans
- create trial after previous FAILED trial

The suite asserts **business/database state**, not just HTTP status codes.

## Engineering and release thinking

### How would you run this suite in CI/CD?

I would run this suite as a GitHub Actions workflow triggered on every pull request and merge to `main`. The workflow would:

1. Set up Node.js 18+ and Python 3.9+ using the respective setup actions.
2. Run `npm ci` to install locked dependencies.
3. Run `npm test` — Playwright automatically starts `server.py` via its `webServer` config, so no separate server step is needed.
4. Upload the `playwright-report/` directory as a workflow artifact for failure investigation.
5. Use a matrix strategy to test across Node 18/20 and Python 3.9/3.12 if cross-version compatibility is needed.

The suite is already designed for headless CI: it uses API-only testing (no browser needed), has deterministic isolation via the reset endpoint, and produces both list and HTML reports.

### Which tests should block a production release?

All `@p0` tests should be **release gates** — they cover critical payment integrity and security:

- Webhook signature validation (security bypass)
- Single-live-trial enforcement (duplicate billing)
- Concurrent trial creation (race conditions)
- State downgrade protection (ACTIVE → FAILED/PENDING)
- Duplicate webhook idempotency (double charges)
- Conflicting SUCCESS events (duplicate payments)
- Reconciliation downgrade protection
- Subscription endpoint correctness (user-facing read)

`@p1` tests (amount validation, reconciliation recovery, transaction ID uniqueness) should block release in most cases but could be overridden with explicit risk acceptance. `@p2` tests (health check, invalid plan, malformed JSON) should warn but not block.

### How would you prevent flaky tests?

1. **Test isolation**: Every test resets the database via `POST /api/admin/reset` in `beforeEach`, eliminating shared state.
2. **Unique identifiers**: Each test generates unique `user_id` values via `crypto.randomUUID()`, preventing cross-test collisions.
3. **Sequential execution**: `fullyParallel: false` and `workers: 1` in the Playwright config prevent in-process race conditions between tests.
4. **Bounded timeouts**: 15-second test timeout and 5-second expect timeout catch hangs without being so tight they cause false failures.
5. **Deterministic concurrency tests**: The concurrent test uses `Promise.all` with a fixed worker count (12) rather than timing-dependent sleeps.
6. **Retry avoidance**: Tests do not use Playwright retries — a failure is a real signal, not noise to retry away.

If flakiness were detected in CI, I would add `retries: 1` only for the specific flaky test while investigating the root cause, and track flake rate per test over time.

### If production shows `provider=SUCCESS` but app status=`PENDING`, what would you inspect first?

1. **Webhook delivery logs**: Check whether the payment provider actually sent the webhook. Look at the provider's dashboard for delivery attempts, HTTP response codes, and retry history.
2. **Application logs for the order_id**: Search for the specific `order_id` in server logs. Did the webhook arrive? Was it processed? Did it return 200?
3. **Signature validation**: Check if the webhook was rejected due to an invalid or missing `X-Signature` header (HTTP 401). The current server has a bug where it does not validate signatures, but a fix might have introduced a regression.
4. **Database state**: Query `SELECT * FROM payments WHERE order_id = '...'` to see if a payment row exists. If it does with `provider_status = 'SUCCESS'` but the trial is still `PENDING`, the UPDATE statement failed or was rolled back.
5. **Concurrency / lock contention**: If the webhook arrived during a concurrent operation on the same order, a database lock timeout or conflict could have silently dropped the update.
6. **Reconciliation**: As an immediate mitigation, trigger `POST /api/reconcile` with the correct `provider_status: SUCCESS` to recover the trial to `ACTIVE`.

### What metrics/alerts would you add for this flow?

**Metrics:**

- Trial creation rate (attempts vs. successes vs. duplicates)
- Webhook receipt rate by status (SUCCESS / FAILED / PENDING)
- Webhook rejection rate (401s from signature failures)
- Time from trial creation to ACTIVE (payment activation latency)
- Age of PENDING trials (how long trials stay unresolved)
- Reconciliation trigger rate and recovery rate
- Duplicate payment event rate per order
- Database write latency and lock contention rate

**Alerts:**

- **P0**: Any trial with provider=SUCCESS but app status ≠ ACTIVE for > 15 minutes
- **P0**: Webhook signature failure rate exceeds baseline (possible attack or key rotation issue)
- **P0**: Duplicate live trials detected for same user+plan
- **P1**: PENDING trial age exceeds 1 hour without any webhook received
- **P1**: Reconciliation failure rate exceeds threshold
- **P2**: Overall webhook 4xx/5xx rate exceeds baseline

## AI/tools used

AI tools were used to review the assignment requirements, identify reliability/security edge cases, and help translate the API test suite from Python/pytest into JavaScript/Playwright. The final tests and expected behaviour were reviewed against the supplied API contract and `server.py`.

## What I would improve with one more day

- Add CI execution with a pinned Node/Python environment.
- Add schema/property-based API validation.
- Add more concurrent webhook/reconciliation scenarios.
- Add database-level uniqueness constraints as a proposed production fix.
- Add production-style contract tests for provider event replay and monitoring thresholds.
