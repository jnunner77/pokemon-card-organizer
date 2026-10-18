import type { LedgerEvent } from '#domain/ledger/events.ts';
import { ok, type Result } from '#shared/result.ts';
import type { EventPublisher, UnitOfWork } from '../ports.ts';

/** What a unit of work produced: the use case's answer and the events of what changed. */
export interface Outcome<T> {
  readonly value: T;
  readonly events: readonly LedgerEvent[];
}

/** Run the work as one unit of work; its events are published only once it is saved. */
export async function commit<T, E>(deps: { readonly unitOfWork: UnitOfWork; readonly events: EventPublisher }, work: () => Promise<Result<Outcome<T>, E>>): Promise<Result<T, E>> {
  const done = await deps.unitOfWork.run(work);
  if (!done.ok) return done;
  await deps.events.publish(done.value.events);
  return ok(done.value.value);
}
