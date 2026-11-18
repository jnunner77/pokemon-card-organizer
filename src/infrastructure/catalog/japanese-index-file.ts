import fs from 'node:fs';
import path from 'node:path';
import type { JapaneseIndexStore } from '#application/catalog/ports.ts';
import type { JapaneseCard, JapaneseIndexData, JapaneseSet } from '#domain/catalog/japanese.ts';

/** The index's file in the data directory. It isn't part of backups: it's rebuilt if it's gone. */
export const JAPANESE_INDEX_FILE = 'japanese-cards.json';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const isNullableText = (v: unknown): v is string | null => v === null || typeof v === 'string';

// On disk, as short keys and arrays to keep the file small (about 2-3 MB for the whole catalog).
function setOf(raw: unknown): JapaneseSet | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { g, n, f, c, r: released, m, t } = r;
  if (!isInt(g) || !isText(n) || !isText(f) || !isNullableText(c) || !isNullableText(released) || !isText(m) || !isText(t)) return null;
  return { groupId: g, name: n, fullName: f, code: c, released, modifiedOn: m, fetchedAt: t };
}

function cardOf(raw: unknown): JapaneseCard | null {
  if (!Array.isArray(raw)) return null;
  const [productId, name, variant, number, rarity = null] = raw as unknown[];
  if (!isInt(productId) || !isText(name) || !isText(variant) || !isText(number) || !isNullableText(rarity)) return null;
  return { productId, name, variant, number, rarity };
}

/** The saved index, checked field by field; null when anything is wrong with it. */
function dataOf(raw: unknown): JapaneseIndexData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { v, completedAt, sets } = raw as Record<string, unknown>;
  if (v !== 1 || !isNullableText(completedAt) || !Array.isArray(sets)) return null;
  const out: { set: JapaneseSet; cards: JapaneseCard[] }[] = [];
  for (const s of sets as unknown[]) {
    const set = setOf(s);
    const rawCards = (s as { cards?: unknown }).cards;
    if (!set || !Array.isArray(rawCards)) return null;
    const cards: JapaneseCard[] = [];
    for (const c of rawCards as unknown[]) {
      const card = cardOf(c);
      if (!card) return null;
      cards.push(card);
    }
    out.push({ set, cards });
  }
  return { version: 1, completedAt, sets: out };
}

/** The Japanese card index as a file, replaced atomically (written beside it, then renamed). */
export class JapaneseIndexFile implements JapaneseIndexStore {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, JAPANESE_INDEX_FILE);
  }

  async load(): Promise<JapaneseIndexData | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.#file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      return dataOf(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }

  async save(data: JapaneseIndexData): Promise<void> {
    const disk = {
      v: 1,
      completedAt: data.completedAt,
      sets: data.sets.map((s) => ({
        g: s.set.groupId,
        n: s.set.name,
        f: s.set.fullName,
        c: s.set.code,
        r: s.set.released,
        m: s.set.modifiedOn,
        t: s.set.fetchedAt,
        cards: s.cards.map((c) => [c.productId, c.name, c.variant, c.number, c.rarity]),
      })),
    };
    const tmp = `${this.#file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(disk));
    await fs.promises.rename(tmp, this.#file);
  }
}
