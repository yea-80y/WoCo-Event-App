/**
 * WoCo's own email, Google and Apple buttons start Web3Auth's sign-in directly,
 * without its chooser in between (owner 2026-10-22). The request is the modal's
 * own: its buttons call `connectTo("auth", params, MODAL)` with params copied from
 * the project's default login method - Login.js `handleFormSubmit` for email,
 * SocialLoginList's rows for the rest - and these are built the same way from the
 * same object (modalManager `filterConnectors` -> `modalConfig.connectors.auth.loginMethods`).
 * Same connection ids, so the same key: web3auth-direct.test.ts pins both sides.
 * Pure: no SDK import, so it runs under node:test.
 */

/** The dashboard's default social connections WoCo's screen offers one tap each ("twitter" is X). */
export type DirectConnection = "google" | "apple" | "facebook" | "twitter" | "discord";

/** Which sign-in a WoCo button asked for; no route = Web3Auth's own chooser. */
export type Web3AuthRoute = { kind: "email"; email: string } | { kind: "social"; connection: DirectConnection };

/** The modal's own email check (Login.js `handleFormSubmit`), so we never send what it would refuse. */
export const EMAIL_PATTERN = /^([\w.%+-]+)@([\w-]+\.)+([\w]{2,})$/i;

/** A login method as the modal holds it after init. */
export type LoginMethodConfig = {
  name?: string;
  authConnection?: string;
  authConnectionId?: string;
  groupedAuthConnectionId?: string;
  extraLoginOptions?: unknown;
  isDefault?: boolean;
};

const EMAIL_PASSWORDLESS = "email_passwordless";

/**
 * The params the modal's own button would send for `route`, or null when the
 * project's method is missing or not the dashboard default - the modal runs a
 * non-default email login differently (`handleCustomLogin`, its in-modal code
 * step), so the caller opens the modal instead.
 */
export function directLoginParams(
  methods: Record<string, LoginMethodConfig> | null,
  route: Web3AuthRoute,
): Record<string, unknown> | null {
  const method = route.kind === "email" ? EMAIL_PASSWORDLESS : route.connection;
  const config = methods?.[method];
  if (!config?.isDefault) return null;
  if (route.kind === "email") {
    return {
      authConnection: EMAIL_PASSWORDLESS,
      authConnectionId: config.authConnectionId,
      groupedAuthConnectionId: config.groupedAuthConnectionId,
      extraLoginOptions: config.extraLoginOptions,
      loginHint: route.email,
      name: "Email",
    };
  }
  const name = config.name || method;
  return {
    authConnection: config.authConnection || method,
    authConnectionId: config.authConnectionId,
    groupedAuthConnectionId: config.groupedAuthConnectionId,
    extraLoginOptions: config.extraLoginOptions,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    login_hint: "",
  };
}
