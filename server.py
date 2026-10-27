#!/usr/bin/env python3
import json
import os
import sqlite3
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DB_PATH = os.path.join(os.path.dirname(__file__), 'qa_challenge.db')
WEBHOOK_SECRET = 'qa-secret'
INTERNAL_KEY = 'qa-internal'
DB_LOCK = threading.Lock()


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(reset=False):
    if reset and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = get_conn()
    cur = conn.cursor()
    cur.execute('''
        CREATE TABLE IF NOT EXISTS trials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            plan TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        )
    ''')
    cur.execute('''
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT NOT NULL,
            provider_txn_id TEXT,
            provider_status TEXT NOT NULL,
            received_at REAL NOT NULL
        )
    ''')
    conn.commit()
    conn.close()


def read_json(handler):
    length = int(handler.headers.get('Content-Length', '0') or '0')
    raw = handler.rfile.read(length) if length else b''
    if not raw:
        return {}, raw
    try:
        return json.loads(raw.decode('utf-8')), raw
    except Exception:
        raise ValueError('invalid_json')


def row_to_dict(row):
    return dict(row) if row else None


class Handler(BaseHTTPRequestHandler):
    server_version = 'AnimallQAChallenge/1.0'

    def log_message(self, fmt, *args):
        sys.stdout.write('%s - - [%s] %s\n' % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def send_json(self, status, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/health':
            return self.send_json(200, {'status': 'ok'})

        if path.startswith('/api/subscriptions/'):
            user_id = path.split('/')[-1]
            conn = get_conn()
            row = conn.execute(
                'SELECT * FROM trials WHERE user_id=? ORDER BY created_at DESC LIMIT 1',
                (user_id,),
            ).fetchone()
            conn.close()
            if not row:
                return self.send_json(404, {'error': 'not_found'})
            return self.send_json(200, row_to_dict(row))

        if path == '/api/debug/payments':
            order_id = parse_qs(parsed.query).get('order_id', [None])[0]
            conn = get_conn()
            if order_id:
                rows = conn.execute(
                    'SELECT * FROM payments WHERE order_id=? ORDER BY id', (order_id,)
                ).fetchall()
            else:
                rows = conn.execute('SELECT * FROM payments ORDER BY id').fetchall()
            conn.close()
            return self.send_json(200, {'payments': [dict(r) for r in rows]})

        if path == '/api/debug/trials':
            user_id = parse_qs(parsed.query).get('user_id', [None])[0]
            conn = get_conn()
            if user_id:
                rows = conn.execute(
                    'SELECT * FROM trials WHERE user_id=? ORDER BY id', (user_id,)
                ).fetchall()
            else:
                rows = conn.execute('SELECT * FROM trials ORDER BY id').fetchall()
            conn.close()
            return self.send_json(200, {'trials': [dict(r) for r in rows]})

        return self.send_json(404, {'error': 'not_found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body, raw = read_json(self)
        except ValueError:
            return self.send_json(400, {'error': 'invalid_json'})

        if path == '/api/admin/reset':
            if self.headers.get('X-Internal-Key') != INTERNAL_KEY:
                return self.send_json(401, {'error': 'unauthorized'})
            init_db(reset=True)
            return self.send_json(200, {'status': 'reset'})

        if path == '/api/trials':
            user_id = str(body.get('user_id', '')).strip()
            plan = str(body.get('plan', '')).strip()
            amount = body.get('amount')
            if not user_id or plan not in ('monthly', 'yearly') or not isinstance(amount, int):
                return self.send_json(400, {'error': 'invalid_request'})

            # Intentionally naive implementation for the QA exercise.
            order_id = 'ord_' + uuid.uuid4().hex[:12]
            now = time.time()
            conn = get_conn()
            conn.execute(
                'INSERT INTO trials(order_id,user_id,plan,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
                (order_id, user_id, plan, amount, 'PENDING', now, now),
            )
            conn.commit()
            conn.close()
            return self.send_json(201, {'order_id': order_id, 'status': 'PENDING'})

        if path == '/api/webhooks/payment':
            order_id = str(body.get('order_id', '')).strip()
            provider_txn_id = body.get('provider_txn_id')
            provider_status = str(body.get('status', '')).upper()
            if provider_status not in ('PENDING', 'SUCCESS', 'FAILED') or not order_id:
                return self.send_json(400, {'error': 'invalid_request'})

            # NOTE: signature handling is intentionally minimal for the challenge.
            conn = get_conn()
            row = conn.execute('SELECT * FROM trials WHERE order_id=?', (order_id,)).fetchone()
            if not row:
                conn.close()
                return self.send_json(200, {'status': 'ignored'})

            now = time.time()
            conn.execute(
                'INSERT INTO payments(order_id,provider_txn_id,provider_status,received_at) VALUES(?,?,?,?)',
                (order_id, provider_txn_id, provider_status, now),
            )
            conn.execute(
                'UPDATE trials SET status=?, updated_at=? WHERE order_id=?',
                ('ACTIVE' if provider_status == 'SUCCESS' else provider_status, now, order_id),
            )
            conn.commit()
            conn.close()
            return self.send_json(200, {'status': 'processed'})

        if path == '/api/reconcile':
            if self.headers.get('X-Internal-Key') != INTERNAL_KEY:
                return self.send_json(401, {'error': 'unauthorized'})
            order_id = str(body.get('order_id', '')).strip()
            provider_status = str(body.get('provider_status', '')).upper()
            provider_txn_id = body.get('provider_txn_id')
            if provider_status not in ('PENDING', 'SUCCESS', 'FAILED') or not order_id:
                return self.send_json(400, {'error': 'invalid_request'})

            conn = get_conn()
            row = conn.execute('SELECT * FROM trials WHERE order_id=?', (order_id,)).fetchone()
            if not row:
                conn.close()
                return self.send_json(404, {'error': 'order_not_found'})

            now = time.time()
            # Intentionally only reconciles PENDING records.
            if row['status'] == 'PENDING':
                conn.execute(
                    'INSERT INTO payments(order_id,provider_txn_id,provider_status,received_at) VALUES(?,?,?,?)',
                    (order_id, provider_txn_id, provider_status, now),
                )
                conn.execute(
                    'UPDATE trials SET status=?, updated_at=? WHERE order_id=?',
                    ('ACTIVE' if provider_status == 'SUCCESS' else provider_status, now, order_id),
                )
                conn.commit()
            conn.close()
            return self.send_json(200, {'status': 'reconciled'})

        return self.send_json(404, {'error': 'not_found'})


def main():
    reset = '--reset' in sys.argv
    init_db(reset=reset)
    host = '127.0.0.1'
    port = 18080
    print(f'QA challenge API running at http://{host}:{port}')
    print('Reset data with: POST /api/admin/reset and header X-Internal-Key: qa-internal')
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == '__main__':
    main()
