import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { documentId, isDocumentId } from '#domain/ledger/ids.ts';

describe('document ids', () => {
  it('are letters, digits, - and _, at most 64', () => {
    assert.equal(isDocumentId('c_1-A'), true);
    assert.equal(isDocumentId('x'.repeat(64)), true);
    for (const bad of ['', 'bad id', 'x'.repeat(65), 'é', 3, null]) assert.equal(isDocumentId(bad), false, String(bad));
    assert.deepEqual(documentId('bad id'), { ok: false, error: { code: 'INVALID_ID', id: 'bad id' } });
    assert.deepEqual(documentId('c1'), { ok: true, value: 'c1' });
  });
});
