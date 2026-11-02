import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { isRecord } from '../ledger/document.ts';
import { isDocumentId } from '../ledger/ids.ts';

// Open trades: trades with a dealer that are being put together, kept on the server so every
// device that can edit sees them. Each has a number (the lowest free one of 1..10) and a version
// that rises with every change, so a device saving from an older version is refused, not merged.

export type OpenTradeId = Brand<string, 'OpenTradeId'>;

export const MAX_OPEN_TRADES = 10;
export const MAX_CUSTOMER = 40;
export const MAX_SIDE_CARDS = 100;
export const MAX_TRADE_CHARS = 256_000;
const MAX_FIELD = 20;

/** A card or line on one side of a trade, as the page keeps it (unknown fields are kept). */
export type TradeItem = Readonly<Record<string, unknown>>;

export interface TradeSide {
  readonly pct: string;
  readonly cash: string;
  readonly items: readonly TradeItem[];
}

export interface OpenTradeContent {
  readonly customer: string;
  readonly dealer: TradeSide;
  readonly mine: TradeSide;
}

export interface OpenTrade extends OpenTradeContent {
  readonly id: OpenTradeId;
  readonly number: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface OpenTradeBook {
  trades: readonly OpenTrade[];
}

export type InvalidOpenTrade = { readonly code: 'INVALID_OPEN_TRADE'; readonly message: string };
export type OpenTradeError =
  | InvalidOpenTrade
  | { readonly code: 'TOO_MANY_OPEN_TRADES'; readonly max: number }
  | { readonly code: 'OPEN_TRADE_CHANGED'; readonly version: number }
  | { readonly code: 'OPEN_TRADE_CLOSED' };

const invalid = (message: string): Result<never, InvalidOpenTrade> => err({ code: 'INVALID_OPEN_TRADE', message });

function readSide(raw: unknown, name: string): Result<TradeSide, InvalidOpenTrade> {
  if (raw === undefined) return ok({ pct: '100', cash: '', items: [] });
  if (!isRecord(raw)) return invalid(`The ${name} side of a trade must be an object`);
  const pct = raw['pct'] ?? '100';
  const cash = raw['cash'] ?? '';
  if (typeof pct !== 'string' || pct.length > MAX_FIELD) return invalid(`The ${name} percentage must be short text`);
  if (typeof cash !== 'string' || cash.length > MAX_FIELD) return invalid(`The ${name} cash must be short text`);
  const items = raw['items'] ?? [];
  if (!Array.isArray(items)) return invalid(`The ${name} cards must be a list`);
  if (items.length > MAX_SIDE_CARDS) return invalid(`A side of a trade has at most ${MAX_SIDE_CARDS} cards`);
  const kept: TradeItem[] = [];
  for (const item of items as unknown[]) {
    if (!isRecord(item)) return invalid(`Each ${name} card must be an object`);
    kept.push(item);
  }
  return ok({ pct, cash, items: kept });
}

/** The customer and both sides of a trade as sent, or what is wrong with them. */
export function checkOpenTradeContent(raw: unknown): Result<OpenTradeContent, InvalidOpenTrade> {
  if (!isRecord(raw)) return invalid('Send the trade as an object');
  const rawCustomer = raw['customer'] ?? '';
  if (typeof rawCustomer !== 'string') return invalid('A customer name must be text');
  const customer = rawCustomer.trim();
  if (customer.length > MAX_CUSTOMER) return invalid(`A customer name is at most ${MAX_CUSTOMER} characters`);
  const dealer = readSide(raw['dealer'], 'dealer');
  if (!dealer.ok) return dealer;
  const mine = readSide(raw['mine'], 'my');
  if (!mine.ok) return mine;
  if (JSON.stringify({ dealer: dealer.value, mine: mine.value }).length > MAX_TRADE_CHARS) return invalid('This trade is too large to save');
  return ok({ customer, dealer: dealer.value, mine: mine.value });
}

/** The lowest number of 1..10 no open trade has, or null when all are taken. */
export function nextTradeNumber(trades: readonly OpenTrade[]): number | null {
  const used = new Set(trades.map((t) => t.number));
  for (let n = 1; n <= MAX_OPEN_TRADES; n++) if (!used.has(n)) return n;
  return null;
}

const sameContent = (a: OpenTradeContent, b: OpenTradeContent): boolean => JSON.stringify([a.customer, a.dealer, a.mine]) === JSON.stringify([b.customer, b.dealer, b.mine]);

export interface SaveOpenTradeInput {
  readonly id: OpenTradeId;
  /** The version the device last saw; 0 for a trade it is opening. */
  readonly baseVersion: number;
  readonly content: OpenTradeContent;
  readonly by: string;
  readonly at: string;
}

/** Create or replace an open trade; the book's list is replaced, never changed in place. */
export function saveOpenTrade(book: OpenTradeBook, input: SaveOpenTradeInput): Result<{ readonly trade: OpenTrade; readonly created: boolean; readonly changed: boolean }, OpenTradeError> {
  const existing = book.trades.find((t) => t.id === input.id);
  if (existing) {
    if (input.baseVersion !== existing.version) return err({ code: 'OPEN_TRADE_CHANGED', version: existing.version });
    if (sameContent(existing, input.content)) return ok({ trade: existing, created: false, changed: false });
    const trade: OpenTrade = { ...existing, ...input.content, version: existing.version + 1, updatedAt: input.at, updatedBy: input.by };
    book.trades = book.trades.map((t) => (t.id === trade.id ? trade : t));
    return ok({ trade, created: false, changed: true });
  }
  if (input.baseVersion !== 0) return err({ code: 'OPEN_TRADE_CLOSED' });
  const number = nextTradeNumber(book.trades);
  if (number === null) return err({ code: 'TOO_MANY_OPEN_TRADES', max: MAX_OPEN_TRADES });
  const trade: OpenTrade = { id: input.id, number, version: 1, ...input.content, createdAt: input.at, updatedAt: input.at, updatedBy: input.by };
  book.trades = [...book.trades, trade];
  return ok({ trade, created: true, changed: true });
}

/** Remove an open trade; it, or null when it was already gone. */
export function discardOpenTrade(book: OpenTradeBook, id: OpenTradeId): OpenTrade | null {
  const found = book.trades.find((t) => t.id === id);
  if (!found) return null;
  book.trades = book.trades.filter((t) => t.id !== id);
  return found;
}

/** The book as saved in the file: entries that are broken, or repeat an id or number, are left out. */
export function openTradeBookFrom(raw: unknown): OpenTradeBook {
  const list = isRecord(raw) && Array.isArray(raw['trades']) ? (raw['trades'] as unknown[]) : [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const trades: OpenTrade[] = [];
  for (const e of list) {
    if (!isRecord(e)) continue;
    const { id, number, version, createdAt, updatedAt, updatedBy } = e;
    if (!isDocumentId(id) || ids.has(id)) continue;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > MAX_OPEN_TRADES || numbers.has(number)) continue;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) continue;
    if (typeof createdAt !== 'string' || typeof updatedAt !== 'string' || typeof updatedBy !== 'string') continue;
    const content = checkOpenTradeContent(e);
    if (!content.ok) continue;
    ids.add(id);
    numbers.add(number);
    // The stored id passed isDocumentId above; it is branded once, as documentId does.
    trades.push({ ...content.value, id: id as OpenTradeId, number, version, createdAt, updatedAt, updatedBy });
  }
  return { trades: trades.slice(0, MAX_OPEN_TRADES) };
}
