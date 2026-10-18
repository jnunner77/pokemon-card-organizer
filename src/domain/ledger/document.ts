// What the ledger stores: binders, cards and settings, each a JSON document under an id. The
// documents are loose on purpose: the page grew fields over time (sale records, notes) and a
// restore must never drop data, so fields the rules don't know about are kept untouched.

export const COLLECTIONS = ['binders', 'cards', 'settings'] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** A document's fields, without its id. */
export type Fields = Readonly<Record<string, unknown>>;

/** Largest single document: room for a card with an inline photo and a long price log. */
export const MAX_DOC_BYTES = 400_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isCollection = (value: string): value is Collection => (COLLECTIONS as readonly string[]).includes(value);

/** The document's own name for error messages: "card", "binder", "setting". */
export const singular = (collection: Collection): string => collection.replace(/s$/, '');
