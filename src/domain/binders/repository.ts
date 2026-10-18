import type { Binder, BinderId } from './binder.ts';

export interface BinderRepository {
  findById(id: BinderId): Promise<Binder | undefined>;
  all(): Promise<readonly Binder[]>;
  save(binder: Binder): Promise<void>;
  delete(binder: Binder): Promise<void>;
}
