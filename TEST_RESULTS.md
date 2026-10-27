# Test Results — Playwright Version

## Environment

- Automation: JavaScript + Playwright Test
- API under test: supplied `server.py`
- Base URL: `http://127.0.0.1:18080`
- Test isolation: `/api/admin/reset` before every test
- Node.js: v24.22.0
- Python: 3.14.7
- Run date: 2026-10-26

## Expected behaviour

The supplied challenge server is intentionally defective. Therefore, some contract tests are expected to fail. A failing contract test is evidence of a defect and should not be "fixed" by changing `server.py`.

## Test run output

```
Running 40 tests using 1 worker

  ✓   1 @p2 health endpoint reports OK (26ms)
  ✓   2 @p1 create monthly trial starts in PENDING (27ms)
  ✓   3 @p1 create yearly trial starts in PENDING (10ms)
  ✓   4 @p2 unsupported plan is rejected (12ms)
  ✓   5 @p2 blank user_id is rejected (6ms)
  ✘   6 @p1 non-positive amount 0 is rejected (10ms)
  ✘   7 @p1 non-positive amount -1 is rejected (31ms)
  ✘   8 @p1 non-positive amount -100 is rejected (32ms)
  ✘   9 @p1 boolean amount is rejected (32ms)
  ✘  10 @p2 malformed JSON is rejected without state change (31ms)
  ✓  11 @p2 missing required amount is rejected (28ms)
  ✘  12 @p0 repeated create request does not create duplicate live trial (16ms)
  ✘  13 @p0 concurrent create requests respect single-live-trial rule (137ms)
  ✘  14 @p0 webhook without signature is rejected and makes no state change (34ms)
  ✘  15 @p0 webhook with invalid signature is rejected and makes no state change (34ms)
  ✓  16 @p0 SUCCESS webhook activates trial and records payment (33ms)
  ✓  17 @p1 FAILED webhook moves PENDING trial to FAILED (12ms)
  ✓  18 @p1 PENDING webhook keeps trial PENDING (10ms)
  ✓  19 @p1 unknown order webhook does not create payment or trial (16ms)
  ✘  20 @p0 duplicate SUCCESS webhook is idempotent (19ms)
  ✘  21 @p0 late FAILED webhook cannot downgrade ACTIVE trial (40ms)
  ✘  22 @p0 late PENDING webhook cannot downgrade ACTIVE trial (39ms)
  ✓  23 @p2 invalid webhook status is rejected without state change (72ms)
  ✘  24 @p0 conflicting duplicate SUCCESS events must not create a second payment (21ms)
  ✓  25 @p1 reconciliation SUCCESS recovers PENDING trial (32ms)
  ✘  26 @p1 reconciliation SUCCESS recovers FAILED trial (18ms)
  ✓  27 @p0 reconciliation cannot downgrade ACTIVE trial (31ms)
  ✓  28 @p1 reconciliation requires internal key and makes no change (12ms)
  ✓  29 @p1 repeated reconciliation SUCCESS is idempotent (11ms)
  ✘  30 @p1 provider transaction ID cannot be reused for another payment (20ms)
  ✓  31 @p0 GET /api/subscriptions returns latest trial for user (30ms)
  ✓  32 @p1 GET /api/subscriptions returns 404 for unknown user (5ms)
  ✓  33 @p0 GET /api/subscriptions reflects ACTIVE after SUCCESS webhook (12ms)
  ✘  34 @p0 concurrent webhooks for the same order do not corrupt state (46ms)
  ✓  35 @p0 FAILED webhook followed by SUCCESS webhook activates trial (34ms)
  ✓  36 @p1 same user can create trials for different plans (10ms)
  ✓  37 @p1 create trial for same plan after previous trial is FAILED (10ms)
  ✓  38 @p1 reconcile unknown order_id returns 404 (10ms)
  ✓  39 @p1 float amount is rejected (6ms)
  ✓  40 @p1 string amount is rejected (10ms)

  16 failed
  24 passed (4.8s)
```

## Summary

| Category | Count |
|---|---|
| Total tests | 40 |
| Passed | 24 |
| Failed | 16 |
| Duration | ~4.8s |

## Failed tests (defect evidence)

| # | Test Name | Priority | Root Cause (Bug ID) |
|---|---|---|---|
| 6-8 | non-positive amount (0, -1, -100) is rejected | P1 | BUG-04: No positive-integer validation |
| 9 | boolean amount is rejected | P1 | BUG-04: `bool` passes `isinstance(int)` |
| 10 | malformed JSON is rejected without state change | P2 | Server returns 500 instead of 400 |
| 12 | repeated create request does not create duplicate live trial | P0 | BUG-02: No duplicate check |
| 13 | concurrent create requests respect single-live-trial rule | P0 | BUG-03: No atomic guard |
| 14 | webhook without signature is rejected | P0 | BUG-01: No signature check |
| 15 | webhook with invalid signature is rejected | P0 | BUG-01: No signature check |
| 20 | duplicate SUCCESS webhook is idempotent | P0 | BUG-05: No deduplication |
| 21 | late FAILED webhook cannot downgrade ACTIVE trial | P0 | BUG-06: Unconditional status update |
| 22 | late PENDING webhook cannot downgrade ACTIVE trial | P0 | BUG-06: Unconditional status update |
| 24 | conflicting duplicate SUCCESS events must not create second payment | P0 | BUG-05: No deduplication |
| 26 | reconciliation SUCCESS recovers FAILED trial | P1 | BUG-07: Only reconciles PENDING |
| 30 | provider transaction ID cannot be reused | P1 | BUG-08: No unique constraint |
| 34 | concurrent webhooks for the same order do not corrupt state | P0 | BUG-05 + no DB_LOCK usage |

## Verification command

```bash
npm test
```

A successful test run means the test runner completed and produced a report; it does **not** mean every test should pass against the intentionally defective starter application.
