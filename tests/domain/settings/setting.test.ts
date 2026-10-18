import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pageMayWrite } from '#domain/settings/setting-fields.ts';
import { Setting, type SettingId } from '#domain/settings/setting.ts';
import { AT, value } from '../fixtures.ts';

describe('Setting', () => {
  it('holds the page settings and checks them', () => {
    const s = value(Setting.create('main' as SettingId, { usdToCad: 1.4 }, AT));
    value(s.merge({ theme: 'dark' }, AT));
    assert.deepEqual(s.toSnapshot(), { id: 'main', fields: { usdToCad: 1.4, theme: 'dark' } });
    assert.equal(s.replace({ usdToCad: -1 }, AT).ok, false);
  });

  it('only main is the page’s to write; the rest are the server’s', () => {
    assert.equal(pageMayWrite('main'), true);
    assert.equal(pageMayWrite('pricing'), false);
  });
});
