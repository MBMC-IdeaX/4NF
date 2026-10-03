import test from 'node:test';
import assert from 'node:assert/strict';
import { codeKind, KIND_LABEL } from '../../src/lib/code-kind.mjs';

test('every prefix the protocol prints is recognised', () => {
  assert.equal(codeKind('BH1|abc'), 'stage-ticket');
  assert.equal(codeKind('BT1|abc'), 'ride-code');
  assert.equal(codeKind('BG1~BT1|a'), 'group-code');
  assert.equal(codeKind('BM1|abc'), 'receipt');
  assert.equal(codeKind('BO1|abc'), 'pass');
  assert.equal(codeKind('CR1|abc'), 'crew-signon');
  assert.equal(codeKind('CT1|abc'), 'cash-ticket');
  assert.equal(codeKind('RS1|abc'), 'roster');
  assert.equal(codeKind('{"v":"BHPAIR1","publicKey":"x"}'), 'pairing');
});

test('anything else is unknown, never a crash', () => {
  assert.equal(codeKind('https://example.com'), 'unknown');
  assert.equal(codeKind(''), 'unknown');
  assert.equal(codeKind(null), 'unknown');
  assert.equal(codeKind('{not json'), 'unknown');
  assert.equal(codeKind('BH1'), 'unknown');
});

test('scanner whitespace is ignored', () => {
  assert.equal(codeKind('  BT1|abc \n'), 'ride-code');
});

test('every kind has a Nepali and English name', () => {
  for (const kind of ['stage-ticket', 'ride-code', 'group-code', 'receipt', 'pass', 'crew-signon', 'cash-ticket', 'roster', 'pairing', 'unknown']) {
    assert.ok(KIND_LABEL[kind]?.ne && KIND_LABEL[kind]?.en, kind);
  }
});

test('bus setup and invite codes from the owner are named, not unknown', () => {
  assert.equal(codeKind(JSON.stringify({ v: 'BHSETUP1', plate: 'BA2KHA7001', code: 'ABCD' })), 'bus-setup');
  assert.equal(codeKind(JSON.stringify({ v: 'BHJOIN1', code: 'ABCDE12345' })), 'join');
});
