import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID_PATTERN, newId, publicUrl, qrPng, token, verify } from '../lib/links.mjs';

test('ids are ten unambiguous symbols', () => {
  for (let i = 0; i < 200; i++) assert.match(newId(), ID_PATTERN);
});

test('tokens are deterministic, 24 chars, and differ per id and per secret', () => {
  const a = token('s1', 'ABCDEFGHJK');
  assert.equal(a.length, 24);
  assert.equal(a, token('s1', 'ABCDEFGHJK'));
  assert.notEqual(a, token('s1', 'ABCDEFGHJL'));
  assert.notEqual(a, token('s2', 'ABCDEFGHJK'));
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('verify accepts the right token and nothing else', () => {
  const t = token('secret', 'ABCDEFGHJK');
  assert.equal(verify('secret', 'ABCDEFGHJK', t), true);
  assert.equal(verify('secret', 'ABCDEFGHJK', ` ${t} `), true);
  assert.equal(verify('secret', 'ABCDEFGHJK', t.slice(0, 23) + (t.at(-1) === 'A' ? 'B' : 'A')), false);
  assert.equal(verify('secret', 'ABCDEFGHJL', t), false);
  assert.equal(verify('secret', 'ABCDEFGHJK', ''), false);
  assert.equal(verify('secret', 'ABCDEFGHJK', null), false);
});

test('no secret: no token, and nothing verifies', () => {
  assert.equal(token('', 'ABCDEFGHJK'), '');
  assert.equal(verify('', 'ABCDEFGHJK', ''), false);
});

test('public url carries id and token under the base', () => {
  const u = publicUrl('https://reports.example.org/', 'ABCDEFGHJK', 'secret');
  assert.equal(u, `https://reports.example.org/r/ABCDEFGHJK?t=${token('secret', 'ABCDEFGHJK')}`);
});

test('qr is a png', async () => {
  const png = await qrPng('https://reports.example.org/r/ABCDEFGHJK?t=x');
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
});
