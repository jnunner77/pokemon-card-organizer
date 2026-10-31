import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exemptFromRateLimits } from '#application/access.ts';
import { LOCAL_OWNER } from '#application/accounts/identity.ts';

describe('who is exempt from rate limits', () => {
  it('is only an administrator signed in with a session', () => {
    assert.equal(exemptFromRateLimits({ name: 'ash', role: 'admin', via: 'session' }), true);
    assert.equal(exemptFromRateLimits(LOCAL_OWNER), false);
    assert.equal(exemptFromRateLimits({ name: 'brock', role: 'editor', via: 'session' }), false);
    assert.equal(exemptFromRateLimits({ name: 'misty', role: 'viewer', via: 'session' }), false);
    assert.equal(exemptFromRateLimits({ name: 'ash', role: 'admin', via: 'token' }), false);
    assert.equal(exemptFromRateLimits({ name: 'brock', role: 'editor', via: 'token' }), false);
    assert.equal(exemptFromRateLimits(null), false);
  });
});
