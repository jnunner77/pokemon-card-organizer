import type { GuestDeps } from './deps.ts';

/** For the guest page: whether guest viewing is open, and whether the QR code's key still works (null without one). */
export class GuestStatus {
  readonly #deps: Pick<GuestDeps, 'desk' | 'secrets'>;

  constructor(deps: Pick<GuestDeps, 'desk' | 'secrets'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly key: string }): Promise<{ readonly open: boolean; readonly keyOk: boolean | null }> {
    const { settings } = (await this.#deps.desk.read()).book;
    return { open: settings.enabled, keyOk: input.key ? this.#deps.secrets.same(input.key, settings.key) : null };
  }
}
