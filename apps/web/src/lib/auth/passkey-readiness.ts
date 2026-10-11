/**
 * Can this device save a WoCo passkey? Asked BEFORE "Create", so a phone that will
 * stop at an iOS settings sheet gets the fix up front (a friend's iPhone 17,
 * 2026-10-10/11). Advice only: it never hides a button, because both signals are
 * the browser's word and email or Google never need a passkey.
 *
 * - `no-prf`: `PublicKeyCredential.getClientCapabilities()` reported
 *   `"extension:prf": false`. Only an explicit false counts: Safari's answer comes
 *   from an AuthenticationServices call whose keys are not documented, and a
 *   missing key means "unknown" (WebAuthn L3).
 * - `no-provider`: iPhone/iPad Safari whose `isUserVerifyingPlatformAuthenticatorAvailable()`
 *   is false. WebKit answers false when AuthenticationServices says the device is not
 *   configured for passkeys (`isDeviceConfiguredForPasskeys`,
 *   WebAuthenticatorCoordinatorProxy.mm) - the state that turns Create into "Choose
 *   how to manage your passkeys". Other iOS browsers (Chrome, Edge, Firefox, Opera)
 *   can bring their own password manager to the page, so their false says less, and
 *   they are left alone.
 */
import { appleTouchDevice } from "./passkey-refusal-copy.js";

export type PasskeyReadiness =
  | { kind: "ok" }
  | { kind: "no-prf" }
  | { kind: "no-provider"; device: "iPhone" | "iPad" };

export interface PasskeyReadinessSignals {
  userAgent: string;
  maxTouchPoints: number;
  /** `isUserVerifyingPlatformAuthenticatorAvailable()`; null = not asked or it failed. */
  uvpaa: boolean | null;
  /** `getClientCapabilities()["extension:prf"]`; undefined = unknown. */
  prf: boolean | undefined;
}

const OTHER_IOS_BROWSER = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//;

export function passkeyReadinessFrom(s: PasskeyReadinessSignals): PasskeyReadiness {
  if (s.prf === false) return { kind: "no-prf" };
  const device = appleTouchDevice(s.userAgent, s.maxTouchPoints);
  if (device && !OTHER_IOS_BROWSER.test(s.userAgent) && s.uvpaa === false) return { kind: "no-provider", device };
  return { kind: "ok" };
}

/** A slow or hung browser answer must never hold the sheet: unknown after this. */
const SIGNAL_TIMEOUT_MS = 1500;

function within<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), SIGNAL_TIMEOUT_MS))]);
}

export async function checkPasskeyReadiness(): Promise<PasskeyReadiness> {
  try {
    const PKC = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential as
      | {
          isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
          getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
        }
      | undefined;
    if (!PKC) return { kind: "ok" };
    const [uvpaa, caps] = await Promise.all([
      PKC.isUserVerifyingPlatformAuthenticatorAvailable
        ? within<boolean | null>(PKC.isUserVerifyingPlatformAuthenticatorAvailable(), null)
        : Promise.resolve(null),
      PKC.getClientCapabilities ? within<Record<string, boolean | undefined> | null>(PKC.getClientCapabilities(), null) : Promise.resolve(null),
    ]);
    const prf = caps?.["extension:prf"];
    return passkeyReadinessFrom({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      uvpaa: typeof uvpaa === "boolean" ? uvpaa : null,
      prf: typeof prf === "boolean" ? prf : undefined,
    });
  } catch {
    return { kind: "ok" };
  }
}
