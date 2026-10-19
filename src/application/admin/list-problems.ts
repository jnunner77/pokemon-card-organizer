import { problemFeed, type ProblemFeed } from '#domain/admin/problems.ts';
import type { AdminDeps } from './deps.ts';

/** Every warning and error since an administrator last marked them as seen (or all kept), grouped. */
export class ListProblems {
  readonly #deps: Pick<AdminDeps, 'log' | 'settings'>;

  constructor(deps: Pick<AdminDeps, 'log' | 'settings'>) {
    this.#deps = deps;
  }

  execute(input: { readonly all: boolean }): ProblemFeed {
    return problemFeed(this.#deps.log, this.#deps.settings.get().problemsSeenAt ?? null, { all: input.all });
  }
}
