import { Binder, type BinderId } from '#domain/binders/binder.ts';
import type { BinderRepository } from '#domain/binders/repository.ts';
import { Card, type CardId } from '#domain/cards/card.ts';
import type { CardRepository } from '#domain/cards/repository.ts';
import type { SettingRepository } from '#domain/settings/repository.ts';
import { Setting, type SettingId } from '#domain/settings/setting.ts';
import { JsonDocuments } from './documents.ts';
import type { CurrentSession } from './unit-of-work.ts';

// Ids read back from db.json were checked by the domain when they were saved (trust boundary).

export class JsonCardRepository extends JsonDocuments<CardId, Card> implements CardRepository {
  constructor(session: CurrentSession) {
    super(session, 'cards', Card.reconstitute, (id) => id as CardId);
  }
}

export class JsonBinderRepository extends JsonDocuments<BinderId, Binder> implements BinderRepository {
  constructor(session: CurrentSession) {
    super(session, 'binders', Binder.reconstitute, (id) => id as BinderId);
  }
}

export class JsonSettingRepository extends JsonDocuments<SettingId, Setting> implements SettingRepository {
  constructor(session: CurrentSession) {
    super(session, 'settings', Setting.reconstitute, (id) => id as SettingId);
  }
}
