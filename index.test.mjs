import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { verifyWebhook, extractCode, routeAlias } from '../src/index.mjs';

test('Svix documented signature vector verifies only unmodified raw body', async () => {
  const secret = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
  const body = '{"event_type":"ping","data":{"success":true}}';
  const timestamp = '1731705121';
  const headers = new Headers({
    'svix-id': 'msg_loFOjxBNrRLzqYUf', 'svix-timestamp': timestamp,
    'svix-signature': 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
  });
  assert.equal(await verifyWebhook(body, headers, secret, Number(timestamp) * 1000), true);
  assert.equal(await verifyWebhook(body + ' ', headers, secret, Number(timestamp) * 1000), false);
  assert.equal(await verifyWebhook(body, headers, secret, (Number(timestamp) + 301) * 1000), false);
  headers.set('svix-signature', 'v1,AAAA');
  assert.equal(await verifyWebhook(body, headers, secret, Number(timestamp) * 1000), false);
});

test('multiple valid signature versions are accepted and current signing matches', async () => {
  const secret = 'whsec_' + Buffer.from('test-secret-key').toString('base64');
  const body = '{"test":1}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', 'test-secret-key').update(`m1.${timestamp}.${body}`).digest('base64');
  const headers = new Headers({ 'svix-id': 'm1', 'svix-timestamp': timestamp,
    'svix-signature': `v2,ignored v1,invalid v1,${sig}` });
  assert.equal(await verifyWebhook(body, headers, secret), true);
});

test('route only a unique registered iCloud alias, never guess a recipient', () => {
  const registered = new Set(['alpha@icloud.com', 'beta@icloud.com']);
  const webhook = { to: ['code@damail.de5.net'] };
  assert.deepEqual(routeAlias({ headers: { To: 'Alpha <alpha@icloud.com>' }, to: ['code@damail.de5.net'] }, webhook, registered).alias, 'alpha@icloud.com');
  assert.equal(routeAlias({ headers: { To: 'alpha@icloud.com, beta@icloud.com' } }, webhook, registered).alias, null);
  assert.equal(routeAlias({ headers: { To: 'code@damail.de5.net' } }, webhook, registered).alias, null);
});

test('extract a contextual six-digit OTP, not phone numbers or timestamps', () => {
  assert.equal(extractCode('验证码：123456', ''), '123456');
  assert.equal(extractCode('Your verification code', 'Use 654321 to continue'), '654321');
  assert.equal(extractCode('Hello', 'Order 12345678'), null);
});

test('signed webhook routes by hidden alias; unresolved mail stays private', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { async batch(statements) { return Promise.all(statements.map(s => s.run())); }, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...args) {
      return {
        first: async () => statement.get(...args) || null,
        all: async () => ({ results: statement.all(...args) }),
        run: async () => statement.run(...args),
      };
    }, all: async () => ({ results: statement.all() }), run: async () => statement.run() };
  } };
  const secret = 'whsec_' + Buffer.from('webhook-test-secret').toString('base64');
  const env = { DB, ADMIN_TOKEN: 'an-admin-token', WEBHOOK_SECRET: secret, RESEND_API_KEY: 're_test' };
  const origin = 'https://otp.example.test';
  async function post(path, data) {
    return worker.fetch(new Request(origin + path, { method: 'POST', headers: {
      Authorization: 'Bearer an-admin-token', 'Content-Type': 'application/json',
    }, body: JSON.stringify(data) }), env);
  }
  const created = await (await post('/admin/aliases', { alias: 'alpha@icloud.com' })).json();
  const second = await (await post('/admin/aliases', { alias: 'beta@icloud.com' })).json();
  assert.notEqual(created.link, second.link);
  const adminResponse = await worker.fetch(new Request(origin), env);
  assert.equal(adminResponse.status, 200);
  const adminHTML = await adminResponse.text();
  new Function(adminHTML.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const listing = await (await worker.fetch(new Request(origin + '/admin/aliases', {
    headers: { Authorization: 'Bearer an-admin-token' },
  }), env)).json();
  assert.equal(listing.aliases.length, 2);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify({
    id: String(url).split('/').at(-1), from: 'Sender <sender@example.com>',
    subject: 'Your verification code', text: 'Use 123456 to sign in',
    to: ['code@damail.de5.net'], headers: { to: 'alpha@icloud.com' },
  }), { headers: { 'Content-Type': 'application/json' } });
  async function webhook(id, signatureOverride) {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: id, to: ['code@damail.de5.net'] } });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', 'webhook-test-secret').update(`msg-${id}.${ts}.${body}`).digest('base64');
    return worker.fetch(new Request(origin + '/webhook/resend', { method: 'POST', headers: {
      'svix-id': `msg-${id}`, 'svix-timestamp': ts,
      'svix-signature': signatureOverride || `v1,${sig}`,
    }, body }), env);
  }
  try {
    assert.equal((await webhook('email-1', 'v1,invalid')).status, 401);
    assert.equal((await webhook('email-1')).status, 200);
    assert.equal((await webhook('email-1')).status, 200);
    const a = await (await worker.fetch(new Request(created.link + '?format=json'), env)).json();
    const b = await (await worker.fetch(new Request(second.link + '?format=json'), env)).json();
    assert.equal(a.messages.length, 1);
    assert.equal(a.messages[0].code, '123456');
    assert.equal(b.messages.length, 0);
    globalThis.fetch = async () => new Response(JSON.stringify({
      from: 'sender@example.com', subject: 'Your code 999999', text: '999999',
      to: ['code@damail.de5.net'], headers: { to: 'noalias@icloud.com' },
    }));
    assert.equal((await webhook('email-2')).status, 200);
    const pending = await (await worker.fetch(new Request(origin + '/admin/unmatched', {
      headers: { Authorization: 'Bearer an-admin-token' },
    }), env)).json();
    assert.equal(pending.messages.length, 1);
    assert.equal((await worker.fetch(new Request(second.link + '?format=json'), env)).status, 200);
    assert.equal((await worker.fetch(new Request(origin + '/admin/unmatched'), env)).status, 401);
    const rotated = await (await post('/admin/rotate', { alias: 'alpha@icloud.com' })).json();
    assert.equal((await worker.fetch(new Request(created.link), env)).status, 404);
    const kept = await (await worker.fetch(new Request(rotated.link + '?format=json'), env)).json();
    assert.equal(kept.messages[0].code, '123456');
    const deleted = await worker.fetch(new Request(origin + '/admin/aliases', {
      method: 'DELETE', headers: { Authorization: 'Bearer an-admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: 'alpha@icloud.com' }),
    }), env);
    assert.equal(deleted.status, 200);
    assert.equal((await worker.fetch(new Request(rotated.link), env)).status, 404);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
    assert.equal((await worker.fetch(new Request(second.link), env)).status, 200);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});
