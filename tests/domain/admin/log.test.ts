import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCategory, isLevel, isLogFileName, redact } from '#domain/admin/log.ts';

describe('log entries', () => {
  it('hide values whose names look secret, at any depth, and trim long text and lists', () => {
    assert.deepEqual(redact({ username: 'a', password: 'p', nested: { token: 't', ok: 1 } }), { username: 'a', password: '[hidden]', nested: { token: '[hidden]', ok: 1 } });
    assert.deepEqual(redact({ Authorization: 'Bearer x', cookie: 'c', setupCode: 's', apiSecret: 'q' }), { Authorization: '[hidden]', cookie: '[hidden]', setupCode: '[hidden]', apiSecret: '[hidden]' });
    assert.equal(redact('x'.repeat(2001)), 'x'.repeat(2000) + '…');
    assert.equal((redact(Array.from({ length: 60 }, (_, i) => i)) as unknown[]).length, 50);
  });

  it('know the levels, categories and daily file names', () => {
    assert.ok(isLevel('warn') && !isLevel('debug'));
    assert.ok(isCategory('pricing') && !isCategory('nope'));
    assert.ok(isLogFileName('2026-10-18.jsonl'));
    assert.ok(!isLogFileName('../auth.json') && !isLogFileName('2026-10-18.jsonl.bak'));
  });
});
