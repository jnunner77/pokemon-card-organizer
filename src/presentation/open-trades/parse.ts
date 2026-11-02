import { isCount, isRecord } from '../http/parse.ts';

/** A save of an open trade: the version it started from and the trade's content, or null when the body isn't that. */
export function openTradeSave(body: unknown): { readonly baseVersion: number; readonly content: unknown } | null {
  if (!isRecord(body)) return null;
  if (Object.keys(body).some((k) => k !== 'baseVersion' && k !== 'customer' && k !== 'dealer' && k !== 'mine')) return null;
  const baseVersion = body['baseVersion'];
  if (!isCount(baseVersion, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { baseVersion, content: { customer: body['customer'], dealer: body['dealer'], mine: body['mine'] } };
}
