/**
 * What the dashboard's setup card cannot cheaply ask the server: whether the
 * attendee-list step is settled on this device, because the importer finished
 * here or the organiser chose "Skip, I'm starting fresh". Per parent, in
 * localStorage.
 *
 * Device-local by design. A device that has neither asks the server whether a
 * list exists (`next-step.ts`), so the worst cross-device outcome is the skip
 * being offered again on a second device before the first event.
 */

const KEY_PREFIX = "woco:onboarding:";

export interface OnboardingRecord {
  importedAudience: boolean;
  skippedImport: boolean;
}

const EMPTY: OnboardingRecord = {
  importedAudience: false,
  skippedImport: false,
};

function keyFor(parent: string): string {
  return KEY_PREFIX + parent.toLowerCase();
}

function read(parent: string): OnboardingRecord {
  try {
    const raw = globalThis.localStorage?.getItem(keyFor(parent));
    if (!raw) return { ...EMPTY };
    const stored = JSON.parse(raw) as Partial<OnboardingRecord>;
    return { importedAudience: stored.importedAudience === true, skippedImport: stored.skippedImport === true };
  } catch {
    return { ...EMPTY };
  }
}

function write(parent: string, rec: OnboardingRecord): void {
  try {
    globalThis.localStorage?.setItem(keyFor(parent), JSON.stringify(rec));
  } catch {
    /* best-effort */
  }
}

/** Parent the singleton store is currently bound to (module-scoped so
 *  markAudienceImported can keep the live store coherent). */
let boundParent: string | null = null;

class OnboardingStore {
  record = $state<OnboardingRecord>({ ...EMPTY });

  /** The attendee-list step needs nothing more from this device. */
  get importSettled(): boolean {
    return this.record.importedAudience || this.record.skippedImport;
  }

  /** Bind the store to the signed-in parent (CreatorHome's auth effect). */
  loadFor(parent: string): void {
    boundParent = parent.toLowerCase();
    this.record = read(boundParent);
  }

  reset(): void {
    boundParent = null;
    this.record = { ...EMPTY };
  }

  skipImport(): void {
    this.record = { ...this.record, skippedImport: true };
    if (boundParent) write(boundParent, this.record);
  }
}

export const onboarding = new OnboardingStore();

/** Called from the audience import path (AudienceScreen) — settles the setup
 *  step without the dashboard having to read the sealed list. */
export function markAudienceImported(parent: string): void {
  const rec = read(parent);
  if (rec.importedAudience) return;
  write(parent, { ...rec, importedAudience: true });
  // Keep the live store coherent if it's bound to the same account.
  if (parent.toLowerCase() === boundParent) {
    onboarding.record = { ...onboarding.record, importedAudience: true };
  }
}
