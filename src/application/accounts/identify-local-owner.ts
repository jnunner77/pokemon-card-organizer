import type { Credentials, Identified } from './identify-caller.ts';
import { LOCAL_OWNER } from './identity.ts';

/** With sign-in turned off (AUTH=off): every request is the local owner. */
export class IdentifyLocalOwner {
  async execute(_input: Credentials): Promise<Identified> {
    return { identity: LOCAL_OWNER, badToken: false };
  }
}
