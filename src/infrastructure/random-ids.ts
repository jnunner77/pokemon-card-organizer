import crypto from 'node:crypto';
import type { IdGenerator } from '#application/ports.ts';

/** 128-bit random ids as 32 hex characters (photo ids). */
export class RandomHexIds implements IdGenerator {
  next(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}
