import crypto from 'node:crypto';
import type { Secrets } from '#application/ports.ts';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** Secrets from Node's cryptographic random numbers; kept as SHA-256 hashes. */
export class NodeSecrets implements Secrets {
  id(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  sessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  apiToken(prefix: string): string {
    return prefix + crypto.randomBytes(24).toString('base64url');
  }

  setupCode(): string {
    return crypto.randomBytes(5).toString('hex').toUpperCase();
  }

  guestKey(): string {
    return crypto.randomBytes(16).toString('base64url');
  }

  digest(secret: string): string {
    return sha256(secret);
  }

  /** Compares the hashes, so neither the length nor the first right characters show. */
  same(given: string, expected: string): boolean {
    return crypto.timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(expected)));
  }
}
