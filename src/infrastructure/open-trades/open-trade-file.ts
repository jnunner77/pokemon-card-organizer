import fs from 'node:fs';
import path from 'node:path';
import type { OpenTradeDraft, OpenTradeShelf } from '#application/open-trades/ports.ts';
import { type OpenTradeBook, openTradeBookFrom } from '#domain/open-trades/open-trade.ts';
import type { Result } from '#shared/result.ts';
import { type Damaged, readJson } from '../json-store/damaged.ts';
import { writePrivate } from '../private-file.ts';

// The open trades in <data>/open-trades.json (readable only by the server: it holds customers'
// names). They are saved about once a second while a trade is being put together, so they are
// not in db.json (which would be rewritten and copied each time) and never reach the ledger's
// copies or full backups. Like guests.json they are written here, not through StoreUnitOfWork,
// which is for changes to the ledger.

export interface FileOpenTradeShelfOptions {
  readonly dataDir: string;
  /** A damaged open-trades.json is set aside and reported; open trades start empty. */
  readonly onDamaged: (message: string) => void;
}

// Not the shared damagedMessage: it quotes the parser's error, and V8's parse errors quote the
// start of the file, which here is a customer's name. Names are never logged.
const damagedMessage = (d: Damaged): string =>
  `${path.basename(d.file)} was damaged${d.setAside ? `; it was kept as ${path.basename(d.setAside)}` : ''}. Open trades start empty.`;

export class FileOpenTradeShelf implements OpenTradeShelf {
  readonly #file: string;
  #book: OpenTradeBook;

  constructor(o: FileOpenTradeShelfOptions) {
    fs.mkdirSync(o.dataDir, { recursive: true });
    this.#file = path.join(o.dataDir, 'open-trades.json');
    const raw = readJson<unknown>(this.#file, (d) => o.onDamaged(damagedMessage(d)));
    this.#book = openTradeBookFrom(raw);
  }

  async read(): Promise<OpenTradeBook> {
    return { trades: this.#book.trades };
  }

  async change<T, E>(work: (draft: OpenTradeDraft) => Result<T, E>): Promise<Result<T, E>> {
    const draft: OpenTradeDraft = { trades: this.#book.trades, changed: false };
    const result = work(draft);
    if (!result.ok || !draft.changed) return result;
    // Saved first: a file that couldn't be written changes nothing.
    const next: OpenTradeBook = { trades: draft.trades };
    writePrivate(this.#file, JSON.stringify(next));
    this.#book = next;
    return result;
  }
}
