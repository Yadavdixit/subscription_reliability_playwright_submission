# QA Engineer Take-Home - Subscription Reliability Challenge

## Goal

This exercise evaluates how you approach quality for a production-critical subscription/payment flow. We care about risk identification, automation quality, debugging, prioritisation, and communication - not the number of test cases you can write.

**Recommended time box:** 3-4 hours. Please stop after 4 hours and mention what you would do next with more time.

AI tools are allowed and encouraged. You should understand and be able to explain everything you submit. Briefly mention which tools you used and where they helped.

## Setup

Prerequisite: Python 3.9+

```bash
python3 server.py --reset
```

The API will run on `http://127.0.0.1:18080`.

Health check:

```bash
curl http://127.0.0.1:18080/health
```

Reset test data at any time:

```bash
curl -X POST http://127.0.0.1:18080/api/admin/reset \
  -H 'X-Internal-Key: qa-internal'
```

The local SQLite database is `qa_challenge.db`. You may query it directly if useful.

## Product context

A user can start a trial for a monthly or yearly subscription. The payment provider processes the payment asynchronously and sends webhooks. Webhooks can be delayed, duplicated, or arrive out of order. If a callback is missed, an internal reconciliation process can later recover the correct state.

### Business rules

1. A user can have only one live trial for the same plan. Repeated client requests must not create duplicate live trials.
2. Trial amount must be a positive integer in paise.
3. New trials start in `PENDING`.
4. Payment provider statuses are `PENDING`, `SUCCESS`, and `FAILED`.
5. A successful payment activates the trial: application status becomes `ACTIVE`.
6. Once a trial is `ACTIVE`, a later duplicate/out-of-order `PENDING` or `FAILED` event must never downgrade it.
7. Provider callbacks are at-least-once. Processing the same payment event repeatedly must be idempotent.
8. A `provider_txn_id` must represent one payment only and must not create duplicate payment records when retried.
9. Payment webhooks must include `X-Signature: qa-secret`. Invalid or missing signatures must return `401` and make no state change.
10. A webhook for an unknown `order_id` must not create any payment or subscription state.
11. Reconciliation is an internal API. It requires `X-Internal-Key: qa-internal`.
12. If the provider reports `SUCCESS`, reconciliation must be able to recover an application record that is incorrectly `PENDING` or `FAILED`.
13. Reconciliation must also be idempotent and must never downgrade an already `ACTIVE` trial.
14. Concurrent requests for the same user/plan must still respect the single-live-trial rule.

## API contract

### Create trial

`POST /api/trials`

```json
{
  "user_id": "user_123",
  "plan": "yearly",
  "amount": 100
}
```

Expected success response: `201` for a newly created trial. A safe retry may return the existing live trial instead of creating another one.

### Payment webhook

`POST /api/webhooks/payment`

Header:

`X-Signature: qa-secret`

```json
{
  "order_id": "ord_xxx",
  "provider_txn_id": "txn_001",
  "status": "SUCCESS"
}
```

### Reconcile payment

`POST /api/reconcile`

Header:

`X-Internal-Key: qa-internal`

```json
{
  "order_id": "ord_xxx",
  "provider_txn_id": "txn_001",
  "provider_status": "SUCCESS"
}
```

### Read current subscription/trial

`GET /api/subscriptions/{user_id}`

### Debug endpoints

`GET /api/debug/trials?user_id=user_123`

`GET /api/debug/payments?order_id=ord_xxx`

These are provided only to make the exercise locally observable. You may also inspect SQLite directly.

## Your assignment

### 1. Risk-based test strategy

Create `TEST_STRATEGY.md` covering:

- the most important risks in this flow;
- the scenarios you would classify as P0 / P1 / P2;
- happy path and negative coverage;
- retries, duplicate webhooks and out-of-order events;
- concurrency/race conditions;
- reconciliation;
- data integrity/database assertions;
- security/authorization relevant to these endpoints;
- what you would automate vs. keep manual;
- what you would monitor after production release.

Keep it concise and prioritised. We value judgment over a very long test-case spreadsheet.

### 2. API automation

Build a small automated test suite in the language/framework of your choice.

Minimum expectations:

- at least 10 meaningful automated tests;
- assertions on business state, not only HTTP status codes;
- at least one idempotency test;
- at least one out-of-order webhook test;
- at least one concurrency/race-condition test;
- at least one reconciliation test;
- test isolation/reset strategy;
- simple command to run the complete suite locally;
- readable failure output/report.

Do **not** modify `server.py` to make your tests pass. The point is to test the supplied system and surface defects.

### 3. Defect report

Create `BUGS.md` with the defects you find. For each defect include:

- title;
- severity/priority;
- preconditions;
- reproduction steps;
- expected vs. actual behaviour;
- evidence (request/response, DB state, logs, or test name);
- user/business impact.

Prioritise the defects. Finding every deliberately planted issue is not required.

### 4. Engineering/release thinking

In `README_SUBMISSION.md`, answer briefly:

- How would you run this suite in CI/CD?
- Which tests should block a production release?
- How would you prevent flaky tests?
- If production shows `provider=SUCCESS` but app status=`PENDING`, what would you inspect first?
- What metrics/alerts would you add for this flow?
- What would you improve if you had one more day?
- Which AI/tools did you use while completing the assignment?

## Submission

Share a GitHub repository or ZIP containing:

- your automated tests and config;
- `TEST_STRATEGY.md`;
- `BUGS.md`;
- `README_SUBMISSION.md`;
- exact setup/run instructions;
- any test report or screenshots you consider useful.

Please do not spend time polishing visual presentation. We care more about correctness, prioritisation, automation design, and clarity.
