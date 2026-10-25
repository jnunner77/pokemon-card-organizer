import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { alertSettingsFrom, checkAlertSettings } from '#domain/admin/alerts.ts';
import { adminSettingsFrom, DEFAULT_ADMIN_SETTINGS } from '#domain/admin/settings.ts';

describe('Price alert settings', () => {
  it('takes a Gmail address, who to send to, the binder\'s address and an app password', () => {
    assert.deepEqual(checkAlertSettings({ gmail: ' Me@Gmail.com ', to: 'a@x.ca, b@y.com', link: 'https://binder.example.com/', password: 'abcd efgh ijkl mnop' }), {
      ok: true,
      value: { settings: { gmail: 'me@gmail.com', to: ['a@x.ca', 'b@y.com'], link: 'https://binder.example.com' }, password: 'abcdefghijklmnop' },
    });
  });

  it('sends to the Gmail address when nobody else is given, and keeps the saved password when none is sent', () => {
    assert.deepEqual(checkAlertSettings({ gmail: 'me@gmail.com' }), { ok: true, value: { settings: { gmail: 'me@gmail.com', to: ['me@gmail.com'], link: '' }, password: null } });
    assert.deepEqual(checkAlertSettings({ gmail: 'me@gmail.com', to: '', password: '' }), { ok: true, value: { settings: { gmail: 'me@gmail.com', to: ['me@gmail.com'], link: '' }, password: null } });
  });

  it('refuses what it can\'t use', () => {
    const bad = (input: unknown) => {
      const r = checkAlertSettings(input);
      assert.equal(r.ok, false, JSON.stringify(input));
    };
    bad(null);
    bad({});
    bad({ gmail: 'not an address' });
    bad({ gmail: 'me@gmail.com', to: 'someone' });
    bad({ gmail: 'me@gmail.com', password: 'hunter2' });
    bad({ gmail: 'me@gmail.com', link: 'javascript:alert(1)' });
    bad({ gmail: 'me@gmail.com', to: 'a@x.ca b@x.ca c@x.ca d@x.ca e@x.ca f@x.ca' });
    bad({ gmail: 'me@gmail.com', extra: 1 });
  });

  it('is read back from admin.json, damaged values left out', () => {
    assert.deepEqual(alertSettingsFrom({ gmail: 'me@gmail.com', to: ['x', 'a@x.ca'], link: 'nope' }), { gmail: 'me@gmail.com', to: ['a@x.ca'], link: '' });
    assert.equal(alertSettingsFrom({ gmail: 'x' }), null);
    assert.equal(adminSettingsFrom({ alerts: { gmail: 'me@gmail.com' } }, DEFAULT_ADMIN_SETTINGS).alerts?.gmail, 'me@gmail.com');
    assert.equal(adminSettingsFrom({}, DEFAULT_ADMIN_SETTINGS).alerts, undefined);
    assert.equal(adminSettingsFrom({ alerts: null }, DEFAULT_ADMIN_SETTINGS).alerts, null);
  });
});
