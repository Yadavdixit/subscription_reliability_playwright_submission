# Defect report

These defects were identified by black-box contract tests against the supplied `server.py`. Test names below are reproducible evidence. Run `pytest -q` to capture the actual response/state and a fresh test report. A failing test is a contract violation in the supplied implementation, not a test-suite setup failure.

## BUG-01 — Payment webhook accepts missing or invalid signatures

- **Priority:** P0 / Critical security and payment integrity
- **Preconditions:** A trial exists and its order ID is known.
- **Reproduction:** Create a trial, then `POST /api/webhooks/payment` with a valid-looking `SUCCESS` body but omit `X-Signature`, or send `X-Signature: wrong`.
- **Expected:** HTTP 401; no payment row and trial remains `PENDING`.
- **Actual:** Handler does not inspect `X-Signature`; callback is processed and state changes.
- **Evidence:** `test_webhook_without_signature_is_rejected_and_makes_no_change`, `test_webhook_with_invalid_signature_is_rejected_and_makes_no_change`.
- **Impact:** An unauthenticated caller who can guess/obtain an order ID can forge payment outcomes and activate subscriptions.

## BUG-02 — Repeated create requests produce duplicate live trials

- **Priority:** P0 / Critical business correctness
- **Preconditions:** Same user and plan submit multiple create requests while the first trial is still `PENDING`.
- **Reproduction:** Call `POST /api/trials` twice with identical `user_id`, `plan`, and `amount`; inspect `/api/debug/trials?user_id=...`.
- **Expected:** One live trial; retry returns/reuses it safely.
- **Actual:** Each request inserts a new `PENDING` row with a fresh order ID.
- **Evidence:** `test_repeated_create_request_does_not_create_duplicate_live_trial`.
- **Impact:** Duplicate billing intents, inconsistent customer state and support burden.

## BUG-03 — Concurrent create requests violate the single-live-trial rule

- **Priority:** P0 / Critical race condition
- **Preconditions:** Concurrent requests for the same user/plan.
- **Reproduction:** Run `test_concurrent_create_requests_respect_single_live_trial_rule`; it submits 12 requests behind a barrier and counts persisted rows.
- **Expected:** Exactly one live trial, enforced atomically in application/database logic.
- **Actual:** The endpoint has no lookup, transaction-level guard or unique constraint, so concurrent requests create multiple rows.
- **Evidence:** `test_concurrent_create_requests_respect_single_live_trial_rule`.
- **Impact:** Duplicate trials under retry storms or network timeouts; ordinary sequential validation alone would miss the race.

## BUG-04 — Non-positive amounts and booleans are accepted

- **Priority:** P1 / High financial validation
- **Preconditions:** Submit an otherwise valid create request with amount `0`, a negative integer, or JSON `true`.
- **Reproduction:** Run `test_create_trial_rejects_non_positive_amount` and `test_create_trial_rejects_boolean_amount`.
- **Expected:** HTTP 400 and no persisted trial because amount must be a positive integer in paise; booleans are not monetary integers.
- **Actual:** Validation checks only `isinstance(amount, int)`, which accepts zero/negative integers and Python's `bool` subtype of `int`.
- **Evidence:** The named tests assert both rejection and no state change.
- **Impact:** Invalid or nonsensical payment amounts enter the subscription flow.

## BUG-05 — Duplicate webhook deliveries create duplicate payment rows

- **Priority:** P0 / Critical idempotency/data integrity
- **Preconditions:** A valid order receives the same provider callback more than once.
- **Reproduction:** Send the same `SUCCESS` body and `provider_txn_id` twice; inspect `/api/debug/payments?order_id=...`.
- **Expected:** One logical payment record; repeated delivery is idempotent.
- **Actual:** Each callback inserts a new row; schema has no unique constraint and handler has no deduplication.
- **Evidence:** `test_duplicate_success_webhook_is_idempotent`.
- **Impact:** Inflated payment records, incorrect reconciliation/reporting and possible downstream double-processing.

## BUG-06 — A late PENDING or FAILED webhook downgrades ACTIVE

- **Priority:** P0 / Critical state-machine correctness
- **Preconditions:** A trial is activated by a `SUCCESS` webhook, then receives an older `FAILED` or `PENDING` event.
- **Reproduction:** Run `test_late_failed_webhook_does_not_downgrade_active_trial` or `test_late_pending_webhook_does_not_downgrade_active_trial`.
- **Expected:** `ACTIVE` remains `ACTIVE` after stale/non-success callbacks.
- **Actual:** Handler unconditionally updates the trial status to the latest received event's mapped status.
- **Evidence:** The named tests read the persisted trial after both callbacks.
- **Impact:** Paid users can lose access due to asynchronous delivery order.

## BUG-07 — Reconciliation cannot recover a FAILED trial

- **Priority:** P1 / High recovery gap
- **Preconditions:** Trial has application status `FAILED`, while provider's authoritative status is `SUCCESS`.
- **Reproduction:** Send a `FAILED` webhook, then call authenticated `/api/reconcile` with `provider_status: SUCCESS`.
- **Expected:** Reconciliation repairs the application status to `ACTIVE` and records the recovered payment idempotently.
- **Actual:** Reconciliation only processes rows whose current status is `PENDING`; it returns success without changing `FAILED`.
- **Evidence:** `test_reconcile_success_recovers_failed_trial`.
- **Impact:** A missed or out-of-order event can leave a legitimately paid user inactive indefinitely.

## BUG-08 — Provider transaction ID is not unique across payments

- **Priority:** P1 / High financial integrity
- **Preconditions:** Two distinct orders are sent callbacks using the same `provider_txn_id`.
- **Reproduction:** Run `test_provider_transaction_id_cannot_be_reused_for_another_payment`.
- **Expected:** Reject the second association (e.g. 409) and retain exactly one payment with that provider transaction ID.
- **Actual:** The schema permits duplicates and callback handler inserts both rows.
- **Evidence:** The named test inspects all payment records.
- **Impact:** One provider transaction can be attributed to multiple orders, corrupting audit and settlement reconciliation.

## Known non-defects / coverage notes

- Unknown-order webhook currently returns `200 ignored` without inserting a payment; that is compatible with the stated no-state-change requirement, so the test allows 200 or 404.
- Internal reconciliation key is checked before processing, and the test asserts unauthorized requests do not change state.
- Reconciliation from `PENDING` to `SUCCESS` works on the happy path.
- `test_reconcile_is_idempotent_for_repeated_success` passes sequentially: the current implementation inserts a payment only while the trial is `PENDING`. This is retained as regression coverage, not reported as a confirmed defect. Concurrent reconciliation/webhook races still need further investigation.


## Additional coverage added in Playwright version

The expanded suite also checks malformed JSON, missing required fields, invalid webhook statuses, and conflicting SUCCESS callbacks. These are additional contract checks; they do not modify the application implementation.
