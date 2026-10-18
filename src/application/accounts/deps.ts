import type { ActivityLog, Clock, Secrets } from '../ports.ts';
import type { AccountStore, FailedSignIns, FirstRunSetup, PasswordHasher, SessionStore } from './ports.ts';

export interface AccountDeps {
  readonly accounts: AccountStore;
  readonly sessions: SessionStore;
  readonly failures: FailedSignIns;
  readonly setup: FirstRunSetup;
  readonly hasher: PasswordHasher;
  readonly secrets: Secrets;
  readonly clock: Clock;
  /** Signing in and out. */
  readonly authLog: ActivityLog;
  /** What administrators change. */
  readonly adminLog: ActivityLog;
  /** Locks and wrong setup codes. */
  readonly securityLog: ActivityLog;
}
