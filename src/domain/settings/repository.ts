import type { Setting, SettingId } from './setting.ts';

export interface SettingRepository {
  findById(id: SettingId): Promise<Setting | undefined>;
  save(setting: Setting): Promise<void>;
  delete(setting: Setting): Promise<void>;
}
