import type { Caller } from '../access.ts';

/** Who is calling, in full: the person (or the API token acting as them) and the role this request may use. */
export interface Identity extends Caller {
  readonly id: string;
  /** The person's name, as people see it. */
  readonly displayName: string;
  readonly via: 'session' | 'token';
}

/** With sign-in turned off (AUTH=off, only on your own computer): everyone is the local owner. */
export const LOCAL_OWNER: Identity = { id: 'local', name: 'local', displayName: 'Local', role: 'admin', via: 'session' };
