import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { damagedMessage, readJson } from './recover';

// Settings only administrators change, kept in <data>/admin.json. They live outside db.json
// so restoring a backup of the ledger never changes how the server itself is run.

export const retentionSchema = z
  .object({
    /** Newest daily copies kept. */
    daily: z.number().int().min(1).max(60),
    /** Plus the newest copy from each of this many recent weeks. */
    weekly: z.number().int().min(0).max(52),
    /** Plus the newest copy from each of this many recent months. */
    monthly: z.number().int().min(0).max(60),
  })
  .strict();

export const pricingConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Hour of the day (0-23) after which the daily price update runs. */
    hour: z.number().int().min(0).max(23),
    /** Whether Cardmarket's price (in euros, from TCGdex) is compared with the others. */
    cardmarket: z.boolean().optional(),
  })
  .strict();

/** How a card's daily price is worked out from its sources (blend.ts, public/blend.js). */
export const priceMethodSchema = z
  .object({
    method: z.enum(['blend', 'highest', 'pricecharting']),
    weights: z.object({ pricecharting: z.number().min(0).max(100), tcgplayer: z.number().min(0).max(100), cardmarket: z.number().min(0).max(100) }).strict(),
    /** Percent from PriceCharting's price beyond which a source is left out. */
    tolerance: z.number().min(1).max(1000),
  })
  .strict()
  .refine((m) => m.weights.pricecharting + m.weights.tcgplayer + m.weights.cardmarket > 0, 'Give at least one source a weight.');
export type PriceMethodConfig = z.infer<typeof priceMethodSchema>;

export type Retention = z.infer<typeof retentionSchema>;
export type PricingConfig = z.infer<typeof pricingConfigSchema>;

export interface AdminConfig {
  backups: Retention;
  pricing: PricingConfig;
  /** How a card's daily price is worked out; the default (blend 40/40/20, 25%) when not set. */
  priceMethod?: PriceMethodConfig | null;
  /** When someone last downloaded a full backup (a copy that leaves the server). */
  lastFullBackupAt: string | null;
  /** When an administrator last marked the problems (warnings and errors) as seen (problems.ts). */
  problemsSeenAt?: string | null;
}

export class Config {
  private readonly file: string;
  private data: AdminConfig;
  /** admin.json was damaged at start and the defaults were used (index.ts logs it). */
  readonly recovered: string | null = null;

  constructor(dataDir: string, defaults: Partial<AdminConfig> = {}) {
    this.file = path.join(dataDir, 'admin.json');
    const base: AdminConfig = { backups: { daily: 14, weekly: 8, monthly: 12 }, pricing: { enabled: true, hour: 5, cardmarket: true }, lastFullBackupAt: null, ...defaults };
    let recovered: string | null = null;
    const saved = readJson<Partial<AdminConfig>>(this.file, (d) => (recovered = damagedMessage(d, 'The default settings are used (backup retention, the price update schedule); check them under Administration.'))) ?? {};
    this.recovered = recovered;
    // "Use PriceCharting" (from when its pages refused the binder) is gone: its API token decides now.
    const { pricecharting: _, ...pricing } = (saved.pricing ?? {}) as Partial<PricingConfig> & { pricecharting?: unknown };
    this.data = { ...base, ...saved, backups: { ...base.backups, ...saved.backups }, pricing: { ...base.pricing, ...pricing } };
  }

  get(): AdminConfig {
    return structuredClone(this.data);
  }

  set(patch: Partial<AdminConfig>) {
    this.data = { ...this.data, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}
