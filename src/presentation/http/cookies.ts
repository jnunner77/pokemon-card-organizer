import type { IncomingMessage } from 'node:http';

// Cookies, written the way Express wrote them: HttpOnly, SameSite=Lax, and Secure behind HTTPS.

/** A cookie's value from the request, or undefined. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** A Set-Cookie value for a sign-in cookie, kept for `maxAgeMs` or (without it) until the browser closes. */
export function signInCookie(name: string, value: string, o: { readonly secure: boolean; readonly maxAgeMs?: number }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (o.maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAgeMs / 1000)}`);
  parts.push('Path=/');
  if (o.maxAgeMs !== undefined) parts.push(`Expires=${new Date(Date.now() + o.maxAgeMs).toUTCString()}`);
  parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push('SameSite=Lax');
  return parts.join('; ');
}

/** A Set-Cookie value that removes the cookie. */
export const clearedCookie = (name: string): string => `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
