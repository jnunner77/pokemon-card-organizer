import crypto from 'node:crypto';
import type { PasswordHasher } from '#application/accounts/ports.ts';

// Passwords hashed with scrypt, stored as "scrypt$N$r$p$salt$key" (base64 salt and key).

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, p: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT.maxmem }, (e, key) => (e ? reject(e) : resolve(key))),
  );
}

export class ScryptHasher implements PasswordHasher {
  /** Made at start, so even the first sign-in attempt for a missing username does one check only. */
  readonly #dummy: Promise<string>;

  constructor() {
    this.#dummy = this.hash(crypto.randomBytes(12).toString('hex'));
  }

  async hash(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
  }

  async verify(password: string, stored: string | null): Promise<boolean> {
    if (stored === null) {
      await this.#check(password, await this.#dummy);
      return false;
    }
    return this.#check(password, stored);
  }

  async #check(password: string, stored: string): Promise<boolean> {
    const [alg, n, r, p, salt, key] = stored.split('$');
    if (alg !== 'scrypt' || !salt || !key) return false;
    const want = Buffer.from(key, 'base64');
    const got = await scrypt(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p), keylen: want.length });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }
}
