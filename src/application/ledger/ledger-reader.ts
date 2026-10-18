/** A binder, card or setting as the page sees it: its fields and its id. */
export type DocumentView = Readonly<Record<string, unknown>> & { readonly id: string };

/** The whole ledger, as GET /api/data sends it. */
export interface LedgerView {
  readonly binders: readonly DocumentView[];
  readonly cards: readonly DocumentView[];
  readonly settings: readonly DocumentView[];
}

/** Reads the whole ledger at once, for pages loading it. */
export interface LedgerReader {
  read(): Promise<LedgerView>;
}

export const viewOf = (id: string, fields: Readonly<Record<string, unknown>>): DocumentView => ({ id, ...fields });
