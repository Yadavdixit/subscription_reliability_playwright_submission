import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

const INTERNAL_HEADERS = { 'X-Internal-Key': 'qa-internal' };
const WEBHOOK_HEADERS = { 'X-Signature': 'qa-secret' };

function uniqueUser(prefix = 'qa') {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function createTrial(request, {
  userId = uniqueUser(),
  plan = 'monthly',
  amount = 100,
} = {}) {
  const response = await request.post('/api/trials', {
    data: { user_id: userId, plan, amount },
  });
  return { response, payload: { user_id: userId, plan, amount } };
}

async function trialsFor(request, userId) {
  const response = await request.get('/api/debug/trials', {
    params: { user_id: userId },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).trials;
}

async function allTrials(request) {
  const response = await request.get('/api/debug/trials');
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).trials;
}

async function paymentsFor(request, orderId) {
  const response = await request.get('/api/debug/payments', {
    params: { order_id: orderId },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).payments;
}

async function allPayments(request) {
  const response = await request.get('/api/debug/payments');
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).payments;
}

async function webhook(request, orderId, {
  status = 'SUCCESS',
  txnId = `txn_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
  headers = WEBHOOK_HEADERS,
} = {}) {
  return request.post('/api/webhooks/payment', {
    data: {
      order_id: orderId,
      provider_txn_id: txnId,
      status,
    },
    headers,
  });
}

async function reconcile(request, orderId, {
  status = 'SUCCESS',
  txnId = `txn_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`,
  headers = INTERNAL_HEADERS,
} = {}) {
  return request.post('/api/reconcile', {
    data: {
      order_id: orderId,
      provider_txn_id: txnId,
      provider_status: status,
    },
    headers,
  });
}

// Every test starts from a clean database. This is the assignment's required
// isolation strategy and is deliberately done through the supplied admin API.
test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/admin/reset', {
    headers: INTERNAL_HEADERS,
  });
  expect(response.status(), await response.text()).toBe(200);
});

// -------------------------
// Basic / trial validation
// -------------------------

test('@p2 health endpoint reports OK', async ({ request }) => {
  const response = await request.get('/health');
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: 'ok' });
});

for (const plan of ['monthly', 'yearly']) {
  test(`@p1 create ${plan} trial starts in PENDING`, async ({ request }) => {
    const { response, payload } = await createTrial(request, { plan });

    expect(response.status(), await response.text()).toBe(201);
    const created = await response.json();

    expect(created.status).toBe('PENDING');
    expect(created.order_id).toBeTruthy();

    const rows = await trialsFor(request, payload.user_id);
    expect(rows).toHaveLength(1);
    expect(rows[0].order_id).toBe(created.order_id);
    expect(rows[0].amount).toBe(payload.amount);
    expect(rows[0].plan).toBe(plan);
    expect(rows[0].status).toBe('PENDING');
  });
}

test('@p2 unsupported plan is rejected', async ({ request }) => {
  const { response, payload } = await createTrial(request, { plan: 'weekly' });

  expect(response.status()).toBe(400);
  expect(await trialsFor(request, payload.user_id)).toEqual([]);
});

test('@p2 blank user_id is rejected', async ({ request }) => {
  const { response, payload } = await createTrial(request, { userId: '   ' });

  expect(response.status()).toBe(400);
  expect(await trialsFor(request, payload.user_id)).toEqual([]);
});

for (const amount of [0, -1, -100]) {
  test(`@p1 non-positive amount ${amount} is rejected`, async ({ request }) => {
    const { response, payload } = await createTrial(request, { amount });

    expect(response.status(), await response.text()).toBe(400);
    expect(await trialsFor(request, payload.user_id)).toEqual([]);
  });
}

test('@p1 boolean amount is rejected', async ({ request }) => {
  const userId = uniqueUser();
  const response = await request.post('/api/trials', {
    data: { user_id: userId, plan: 'monthly', amount: true },
  });

  expect(response.status(), await response.text()).toBe(400);
  expect(await trialsFor(request, userId)).toEqual([]);
});

test('@p2 malformed JSON is rejected without state change', async ({ request }) => {
  const response = await request.post('/api/trials', {
    data: '{"user_id":"qa_malformed","plan":"monthly","amount":',
    headers: { 'Content-Type': 'application/json' },
  });

  expect(response.status()).toBe(400);
  expect(await trialsFor(request, 'qa_malformed')).toEqual([]);
});

test('@p2 missing required amount is rejected', async ({ request }) => {
  const userId = uniqueUser();
  const response = await request.post('/api/trials', {
    data: { user_id: userId, plan: 'monthly' },
  });

  expect(response.status()).toBe(400);
  expect(await trialsFor(request, userId)).toEqual([]);
});

// -------------------------
// Idempotency / concurrency
// -------------------------

test('@p0 repeated create request does not create duplicate live trial', async ({ request }) => {
  const userId = uniqueUser();

  const first = await createTrial(request, { userId, plan: 'yearly' });
  const second = await createTrial(request, { userId, plan: 'yearly' });

  expect(first.response.status()).toBe(201);
  expect([200, 201]).toContain(second.response.status());

  const rows = await trialsFor(request, userId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('PENDING');
});

test('@p0 concurrent create requests respect single-live-trial rule', async ({ request }) => {
  const userId = uniqueUser('race');
  const workers = 12;

  const responses = await Promise.all(
    Array.from({ length: workers }, () =>
      request.post('/api/trials', {
        data: { user_id: userId, plan: 'monthly', amount: 100 },
      })
    )
  );

  const statuses = responses.map(r => r.status());
  expect(statuses.every(status => [200, 201].includes(status))).toBeTruthy();

  const rows = await trialsFor(request, userId);
  expect(rows, `concurrent retries created ${rows.length} trials; statuses=${statuses}`).toHaveLength(1);
});

// -------------------------
// Payment webhook
// -------------------------

test('@p0 webhook without signature is rejected and makes no state change', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const callback = await webhook(request, orderId, { headers: {} });

  expect(callback.status()).toBe(401);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('PENDING');
  expect(await paymentsFor(request, orderId)).toEqual([]);
});

test('@p0 webhook with invalid signature is rejected and makes no state change', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const callback = await webhook(request, orderId, {
    headers: { 'X-Signature': 'wrong' },
  });

  expect(callback.status()).toBe(401);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('PENDING');
  expect(await paymentsFor(request, orderId)).toEqual([]);
});

test('@p0 SUCCESS webhook activates trial and records payment', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const callback = await webhook(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_success_1',
  });

  expect(callback.status(), await callback.text()).toBe(200);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');

  const payments = await paymentsFor(request, orderId);
  expect(payments).toHaveLength(1);
  expect(payments[0].provider_txn_id).toBe('txn_success_1');
  expect(payments[0].provider_status).toBe('SUCCESS');
});

test('@p1 FAILED webhook moves PENDING trial to FAILED', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const callback = await webhook(request, orderId, {
    status: 'FAILED',
    txnId: 'txn_failed_1',
  });

  expect(callback.status()).toBe(200);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('FAILED');

  const payments = await paymentsFor(request, orderId);
  expect(payments).toHaveLength(1);
  expect(payments[0].provider_status).toBe('FAILED');
});

test('@p1 PENDING webhook keeps trial PENDING', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const callback = await webhook(request, orderId, {
    status: 'PENDING',
    txnId: 'txn_pending_1',
  });

  expect(callback.status()).toBe(200);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('PENDING');
  expect((await paymentsFor(request, orderId))).toHaveLength(1);
});

test('@p1 unknown order webhook does not create payment or trial', async ({ request }) => {
  const orderId = `ord_unknown_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

  const callback = await webhook(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_unknown',
  });

  expect([200, 404]).toContain(callback.status());
  expect(await paymentsFor(request, orderId)).toEqual([]);
  expect(await allTrials(request)).toEqual([]);
});

test('@p0 duplicate SUCCESS webhook is idempotent', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;
  const body = {
    order_id: orderId,
    provider_txn_id: 'txn_idempotent',
    status: 'SUCCESS',
  };

  const first = await request.post('/api/webhooks/payment', {
    data: body,
    headers: WEBHOOK_HEADERS,
  });
  const second = await request.post('/api/webhooks/payment', {
    data: body,
    headers: WEBHOOK_HEADERS,
  });

  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
  expect(await paymentsFor(request, orderId)).toHaveLength(1);
});

test('@p0 late FAILED webhook cannot downgrade ACTIVE trial', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  expect((await webhook(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_ordered',
  })).status()).toBe(200);

  expect((await webhook(request, orderId, {
    status: 'FAILED',
    txnId: 'txn_ordered',
  })).status()).toBe(200);

  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
});

test('@p0 late PENDING webhook cannot downgrade ACTIVE trial', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  await webhook(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_pending_late',
  });
  await webhook(request, orderId, {
    status: 'PENDING',
    txnId: 'txn_pending_late',
  });

  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
});

test('@p2 invalid webhook status is rejected without state change', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const callback = await webhook(request, orderId, {
    status: 'REFUNDED',
    txnId: 'txn_invalid_status',
  });

  expect(callback.status()).toBe(400);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('PENDING');
  expect(await paymentsFor(request, orderId)).toEqual([]);
});

test('@p0 conflicting duplicate SUCCESS events must not create a second payment', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const first = await webhook(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_conflict_1',
  });
  const second = await webhook(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_conflict_2',
  });

  expect(first.status()).toBe(200);
  expect([200, 400, 409]).toContain(second.status());

  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
  const payments = await paymentsFor(request, orderId);
  expect(payments).toHaveLength(1);
  expect(payments[0].provider_txn_id).toBe('txn_conflict_1');
});

// -------------------------
// Reconciliation
// -------------------------

test('@p1 reconciliation SUCCESS recovers PENDING trial', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const result = await reconcile(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_reconcile_pending',
  });

  expect(result.status()).toBe(200);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');

  const payments = await paymentsFor(request, orderId);
  expect(payments).toHaveLength(1);
  expect(payments[0].provider_status).toBe('SUCCESS');
});

test('@p1 reconciliation SUCCESS recovers FAILED trial', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  await webhook(request, orderId, {
    status: 'FAILED',
    txnId: 'txn_failed_first',
  });

  const result = await reconcile(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_recover_failed',
  });

  expect(result.status()).toBe(200);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
});

test('@p0 reconciliation cannot downgrade ACTIVE trial', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  await webhook(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_active_reconcile',
  });

  const result = await reconcile(request, orderId, {
    status: 'FAILED',
    txnId: 'txn_active_reconcile_failed',
  });

  expect(result.status()).toBe(200);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
});

test('@p1 reconciliation requires internal key and makes no change', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const result = await reconcile(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_unauthorized',
    headers: {},
  });

  expect(result.status()).toBe(401);
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('PENDING');
  expect(await paymentsFor(request, orderId)).toEqual([]);
});

test('@p1 repeated reconciliation SUCCESS is idempotent', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  await reconcile(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_reconcile_same',
  });
  await reconcile(request, orderId, {
    status: 'SUCCESS',
    txnId: 'txn_reconcile_same',
  });

  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
  expect(await paymentsFor(request, orderId)).toHaveLength(1);
});

test('@p1 provider transaction ID cannot be reused for another payment', async ({ request }) => {
  const first = await createTrial(request, { userId: uniqueUser() });
  const second = await createTrial(request, { userId: uniqueUser() });

  const firstOrder = (await first.response.json()).order_id;
  const secondOrder = (await second.response.json()).order_id;
  const txnId = 'txn_global_unique';

  expect((await webhook(request, firstOrder, {
    status: 'SUCCESS',
    txnId,
  })).status()).toBe(200);

  const secondResult = await webhook(request, secondOrder, {
    status: 'SUCCESS',
    txnId,
  });

  expect([400, 409]).toContain(
    secondResult.status(),
    `transaction ID reuse was not rejected: ${secondResult.status()} ${await secondResult.text()}`
  );

  const all = await allPayments(request);
  expect(all.filter(p => p.provider_txn_id === txnId)).toHaveLength(1);
  expect(await paymentsFor(request, secondOrder)).toHaveLength(0);
});

// -------------------------
// Subscription read endpoint (GET /api/subscriptions/{user_id})
// -------------------------

test('@p0 GET /api/subscriptions returns latest trial for user', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const sub = await request.get(`/api/subscriptions/${payload.user_id}`);
  expect(sub.status()).toBe(200);

  const body = await sub.json();
  expect(body.user_id).toBe(payload.user_id);
  expect(body.order_id).toBe(orderId);
  expect(body.status).toBe('PENDING');
  expect(body.plan).toBe(payload.plan);
  expect(body.amount).toBe(payload.amount);
});

test('@p1 GET /api/subscriptions returns 404 for unknown user', async ({ request }) => {
  const sub = await request.get(`/api/subscriptions/nonexistent_user_${Date.now()}`);
  expect(sub.status()).toBe(404);
});

test('@p0 GET /api/subscriptions reflects ACTIVE after SUCCESS webhook', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  await webhook(request, orderId, { status: 'SUCCESS', txnId: 'txn_sub_active' });

  const sub = await request.get(`/api/subscriptions/${payload.user_id}`);
  expect(sub.status()).toBe(200);

  const body = await sub.json();
  expect(body.status).toBe('ACTIVE');
  expect(body.order_id).toBe(orderId);
});

// -------------------------
// Additional top-priority coverage
// -------------------------

test('@p0 concurrent webhooks for the same order do not corrupt state', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      webhook(request, orderId, {
        status: 'SUCCESS',
        txnId: `txn_race_wh_${i}`,
      })
    )
  );

  results.forEach(r => expect([200, 400, 409]).toContain(r.status()));

  const trial = (await trialsFor(request, payload.user_id))[0];
  expect(trial.status).toBe('ACTIVE');

  // Only one payment should exist for this order
  const payments = await paymentsFor(request, orderId);
  expect(payments).toHaveLength(1);
});

test('@p0 FAILED webhook followed by SUCCESS webhook activates trial', async ({ request }) => {
  const { response, payload } = await createTrial(request);
  const orderId = (await response.json()).order_id;

  await webhook(request, orderId, { status: 'FAILED', txnId: 'txn_fail_first' });
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('FAILED');

  await webhook(request, orderId, { status: 'SUCCESS', txnId: 'txn_success_recover' });
  expect((await trialsFor(request, payload.user_id))[0].status).toBe('ACTIVE');
});

test('@p1 same user can create trials for different plans', async ({ request }) => {
  const userId = uniqueUser();

  const monthly = await createTrial(request, { userId, plan: 'monthly' });
  const yearly = await createTrial(request, { userId, plan: 'yearly' });

  expect(monthly.response.status()).toBe(201);
  expect(yearly.response.status()).toBe(201);

  const rows = await trialsFor(request, userId);
  const plans = rows.map(r => r.plan).sort();
  expect(plans).toEqual(['monthly', 'yearly']);
});

test('@p1 create trial for same plan after previous trial is FAILED', async ({ request }) => {
  const userId = uniqueUser();

  const first = await createTrial(request, { userId, plan: 'monthly' });
  const firstOrderId = (await first.response.json()).order_id;

  await webhook(request, firstOrderId, { status: 'FAILED', txnId: 'txn_fail_done' });
  expect((await trialsFor(request, userId))[0].status).toBe('FAILED');

  const second = await createTrial(request, { userId, plan: 'monthly' });
  expect(second.response.status()).toBe(201);
});

test('@p1 reconcile unknown order_id returns 404', async ({ request }) => {
  const result = await reconcile(request, `ord_nonexistent_${Date.now()}`, {
    status: 'SUCCESS',
    txnId: 'txn_unknown_recon',
  });

  expect(result.status()).toBe(404);
});

test('@p1 float amount is rejected', async ({ request }) => {
  const userId = uniqueUser();
  const response = await request.post('/api/trials', {
    data: { user_id: userId, plan: 'monthly', amount: 99.5 },
  });

  expect(response.status(), await response.text()).toBe(400);
  expect(await trialsFor(request, userId)).toEqual([]);
});

test('@p1 string amount is rejected', async ({ request }) => {
  const userId = uniqueUser();
  const response = await request.post('/api/trials', {
    data: { user_id: userId, plan: 'monthly', amount: '100' },
  });

  expect(response.status(), await response.text()).toBe(400);
  expect(await trialsFor(request, userId)).toEqual([]);
});
