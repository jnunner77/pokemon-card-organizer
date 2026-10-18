import type { LedgerDeps } from './deps.ts';
import type { LedgerView } from './ledger-reader.ts';

/** Every binder, card and setting, for a page loading the ledger. */
export class ReadLedger {
  readonly #deps: Pick<LedgerDeps, 'reader'>;

  constructor(deps: Pick<LedgerDeps, 'reader'>) {
    this.#deps = deps;
  }

  execute(): Promise<LedgerView> {
    return this.#deps.reader.read();
  }
}
