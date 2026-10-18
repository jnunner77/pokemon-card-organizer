import type { GuestDeps } from '#application/guests/deps.ts';
import { ClearGuestLog } from '#application/guests/clear-guest-log.ts';
import { EndGuestVisit } from '#application/guests/end-guest-visit.ts';
import { GuestOverview } from '#application/guests/guest-overview.ts';
import { GuestStatus } from '#application/guests/guest-status.ts';
import { IdentifyGuest } from '#application/guests/identify-guest.ts';
import { ListGuestCards } from '#application/guests/list-guest-cards.ts';
import { NewGuestKey } from '#application/guests/new-guest-key.ts';
import { OpenGuestPicture } from '#application/guests/open-guest-picture.ts';
import { ReadGuestViewing } from '#application/guests/read-guest-viewing.ts';
import { SetGuestViewing } from '#application/guests/set-guest-viewing.ts';
import { SignInGuest } from '#application/guests/sign-in-guest.ts';
import { SignOutGuest } from '#application/guests/sign-out-guest.ts';
import { SweepGuests } from '#application/guests/sweep-guests.ts';
import type { DocumentView } from '#application/ledger/ledger-reader.ts';
import { CountingSecrets } from '#infrastructure/memory/accounts.ts';
import { MemoryGuestDesk, NoConditionRules, TextQrCodes } from '#infrastructure/memory/guests.ts';
import { MemoryPhotoStore } from '#infrastructure/memory/photos.ts';
import { NodeBase64 } from '#infrastructure/node-base64.ts';

export const START = Date.parse('2026-10-05T18:00:00.000Z');

/** The guest use cases over memory, with a ledger of the cards given and a clock tests move. */
export function setUpGuests(cards: DocumentView[] = [], settings: DocumentView[] = []) {
  const clock = { at: START };
  const logged = { auth: [] as string[], admin: [] as string[] };
  const log = (into: string[]) => ({ info: (m: string) => void into.push(m), warn: (m: string) => void into.push(m) });
  const desk = new MemoryGuestDesk({ settings: { enabled: false, key: 'the-key', keyCreatedAt: new Date(START).toISOString() }, log: [] });
  const photos = new MemoryPhotoStore();
  const deps: GuestDeps = {
    desk,
    ledger: { read: async () => ({ binders: [], cards, settings }) },
    photos,
    condition: new NoConditionRules(),
    qr: new TextQrCodes(),
    secrets: new CountingSecrets(),
    base64: new NodeBase64(),
    clock: { now: () => new Date(clock.at) },
    authLog: log(logged.auth),
    adminLog: log(logged.admin),
  };
  const use = {
    viewing: new ReadGuestViewing(deps),
    status: new GuestStatus(deps),
    signIn: new SignInGuest(deps),
    identify: new IdentifyGuest(deps),
    signOut: new SignOutGuest(deps),
    listCards: new ListGuestCards(deps),
    openPicture: new OpenGuestPicture(deps),
    overview: new GuestOverview(deps),
    setViewing: new SetGuestViewing(deps),
    newKey: new NewGuestKey(deps),
    endVisit: new EndGuestVisit(deps),
    clearLog: new ClearGuestLog(deps),
    sweep: new SweepGuests(deps),
  };
  const visit = async (name: string, contact: string, key = 'the-key') => use.signIn.execute({ key, name, contact, ip: '10.0.0.1', agent: 'phone' });
  const signedIn = async (name: string, contact: string) => {
    const r = await visit(name, contact);
    if (!r.ok) throw new Error(`couldn't sign in ${name}: ${r.error.code}`);
    return r.value.token;
  };
  const overview = () => use.overview.execute({ linkFor: (key) => `https://binder.test/guest.html?k=${key}` });
  return { deps, use, clock, logged, desk, photos, visit, signedIn, overview };
}
