import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPageError, countPageError, describePageError, NO_PAGE_ERRORS, type PageErrorWindow } from '#domain/admin/page-errors.ts';

describe('page errors', () => {
  it('log 30 a minute, warn once on the 31st, then drop until the minute is up', () => {
    let window: PageErrorWindow = NO_PAGE_ERRORS;
    const verdicts: string[] = [];
    const t0 = Date.parse('2026-10-03T12:00:00Z');
    for (let i = 0; i < 33; i++) {
      const r = countPageError(window, t0 + i);
      window = r.window;
      verdicts.push(r.verdict);
    }
    assert.deepEqual(verdicts.slice(28), ['log', 'log', 'warn', 'drop', 'drop']);
    assert.equal(countPageError(window, t0 + 60_000).verdict, 'drop'); // still the minute that started at t0
    assert.equal(countPageError(window, t0 + 60_001).verdict, 'log');
  });

  it('take what the page sends, dropping fields it does not know, and describe it for the log', () => {
    const r = checkPageError({ kind: 'oops', message: 'boom', page: 'binder', source: 'http://x/app.js', line: 812, stack: 'TypeError', extra: 1 });
    assert.deepEqual(r, { ok: true, value: { kind: 'error', message: 'boom', page: 'binder', source: 'http://x/app.js', line: 812, col: undefined, stack: 'TypeError' } });
    assert.ok(r.ok);
    assert.deepEqual(describePageError(r.value), { message: 'Page error on binder: boom', details: { kind: 'error', at: 'http://x/app.js:812:?', stack: 'TypeError' } });
    assert.deepEqual(describePageError({ kind: 'rejection', message: 'x' }), { message: 'Page error: x', details: { kind: 'rejection' } });
    const refused = (input: unknown) => {
      const c = checkPageError(input);
      assert.ok(!c.ok);
      return c.error.message;
    };
    assert.equal(refused({ message: 'y'.repeat(501) }), 'Too big: expected string to have <=500 characters');
    assert.equal(refused({}), 'Invalid input: expected string, received undefined');
    assert.equal(refused({ message: 'm', line: -1 }), 'Too small: expected number to be >=0');
    assert.equal(refused({ message: 'm', col: 1.5 }), 'Invalid input: expected int, received number');
    assert.equal(refused(undefined), 'Invalid input: expected object, received undefined');
  });
});
