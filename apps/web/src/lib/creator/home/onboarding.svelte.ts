/**
 * First-visit organiser onboarding state (welcome question + Getting Started
 * checklist on CreatorHome). Step completion for Stripe/events/sites is DERIVED
 * from data the home screen already loads; only what it can't cheaply know is
 * persisted here, per-parent in localStorage:
 *   - whether the welcome question was answered (and its answer)
 *   - whether an audience import ever completed (reading the real list means
 *     downloading + unsealing a Swarm blob — too heavy for the home screen)
 * Device-local by design: the worst cross-device outcome is replaying a
 * two-tap welcome on a second device.
 */

const KEY_PREFIX = "woco:onboarding:";

export interface OnboardingRecord {
  seenWelcome: boolean;
  dismissed: boolean;
  /** "yes" = already runs events on another platform → the audience-import
   *  step is promoted right after Stripe; "no" hides it. */
  hostsElsewhere: "yes" | "no" | null;
  importedAudience: boolean;
}

const EMPTY: OnboardingRecord = {
  seenWelcome: false,
  dismissed: false,
  hostsElsewhere: null,
  importedAudience: false,
};

function keyFor(parent: string): string {
  return KEY_PREFIX + parent.toLowerCase();
}

function read(parent: string): OnboardingRecord {
  try {
    const raw = globalThis.localStorage?.getItem(keyFor(parent));
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<OnboardingRecord>) };
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

  /** Bind the store to the signed-in parent (CreatorHome's auth effect). */
  loadFor(parent: string): void {
    boundParent = parent.toLowerCase();
    this.record = read(boundParent);
  }

  reset(): void {
    boundParent = null;
    this.record = { ...EMPTY };
  }

  private patch(p: Partial<OnboardingRecord>): void {
    this.record = { ...this.record, ...p };
    if (boundParent) write(boundParent, this.record);
  }

  answerWelcome(hostsElsewhere: "yes" | "no"): void {
    this.patch({ seenWelcome: true, hostsElsewhere });
  }

  skipWelcome(): void {
    this.patch({ seenWelcome: true });
  }

  dismiss(): void {
    this.patch({ dismissed: true });
  }
}

export const onboarding = new OnboardingStore();

/** Called from the audience import path (AudienceScreen) — records completion
 *  for the checklist without the home screen having to read the sealed list. */
export function markAudienceImported(parent: string): void {
  const rec = read(parent);
  if (rec.importedAudience) return;
  write(parent, { ...rec, importedAudience: true });
  // Keep the live store coherent if it's bound to the same account.
  if (parent.toLowerCase() === boundParent) {
    onboarding.record = { ...onboarding.record, importedAudience: true };
  }
}
