import { statusText } from '#domain/admin/status.ts';
import { cardsNeedingAttention } from '#domain/cards/attention.ts';
import type { AdminDeps } from './deps.ts';
import type { OverviewChecks } from './overview-checks.ts';

/** Write status.txt for the server's nightly job: the checks, and the cards that need a person. */
export class WriteStatusFile {
  readonly #deps: Pick<AdminDeps, 'ledger' | 'statusFile' | 'clock'> & { readonly checks: Pick<OverviewChecks, 'execute'> };

  constructor(deps: Pick<AdminDeps, 'ledger' | 'statusFile' | 'clock'> & { readonly checks: Pick<OverviewChecks, 'execute'> }) {
    this.#deps = deps;
  }

  async execute(): Promise<void> {
    // As if asked over HTTPS from outside: the checks about the request itself are left out of the file.
    const checks = await this.#deps.checks.execute({ secure: true, untrustedProxy: false, localRequest: false });
    const { cards } = await this.#deps.ledger.read();
    await this.#deps.statusFile.write(statusText(this.#deps.clock.now(), checks, cardsNeedingAttention(cards)));
  }
}
