import { checkSeenMark, type InvalidSeenMark, problemFeed, type ProblemFeed, seenUpTo } from '#domain/admin/problems.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AdminDeps } from './deps.ts';

/** Mark the problems as seen, up to the newest one the page showed; the feed after it. */
export class MarkProblemsSeen {
  readonly #deps: Pick<AdminDeps, 'log' | 'settings' | 'clock'>;

  constructor(deps: Pick<AdminDeps, 'log' | 'settings' | 'clock'>) {
    this.#deps = deps;
  }

  execute(input: { readonly body: unknown }): Result<ProblemFeed, InvalidSeenMark> {
    const upTo = checkSeenMark(input.body);
    if (!upTo.ok) return upTo;
    const at = seenUpTo(upTo.value, this.#deps.clock.now());
    this.#deps.settings.set({ problemsSeenAt: at });
    return ok(problemFeed(this.#deps.log, at));
  }
}
