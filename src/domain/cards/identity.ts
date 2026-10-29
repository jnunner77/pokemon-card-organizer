import { isBlank, norm, ownNumber, setLabel, setSize } from '../catalog/names.ts';
import type { Fields } from '../ledger/document.ts';

// When two cards are "the same card": the same printing, so a binder pocket may hold both. Their
// name, number, set, variant and language match; condition, grade, owner, status, price and notes
// don't matter (each copy keeps its own). Case, accents and punctuation don't matter, 51 and
// 051/162 are the same number, a blank set matches any set and a blank language counts as English.
// public/stack.js (BinderStack.same) mirrors this rule for the page: keep the two in step, and
// keep tests/domain/cards/identity.test.ts and tests/legacy/stack.test.ts on the same cases.

const text = (f: Fields, key: string): string => (typeof f[key] === 'string' ? f[key] : '');

function sameSet(a: Fields, b: Fields): boolean {
  const codeA = text(a, 'setCode');
  const codeB = text(b, 'setCode');
  if (!isBlank(codeA) && !isBlank(codeB)) return norm(codeA) === norm(codeB);
  const setA = text(a, 'set');
  const setB = text(b, 'set');
  if (!isBlank(setA) && !isBlank(setB)) return norm(setLabel(setA)) === norm(setLabel(setB));
  return true;
}

/** Whether two cards (their fields) are copies of the same printing. */
export function sameCard(a: Fields, b: Fields): boolean {
  if (norm(a['name']) !== norm(b['name'])) return false;
  if (ownNumber(a['number']) !== ownNumber(b['number'])) return false;
  const sizeA = setSize(a['number']);
  const sizeB = setSize(b['number']);
  if (sizeA !== null && sizeB !== null && sizeA !== sizeB) return false;
  if (!sameSet(a, b)) return false;
  if (norm(a['variant']) !== norm(b['variant'])) return false;
  return norm(text(a, 'language') || 'English') === norm(text(b, 'language') || 'English');
}
