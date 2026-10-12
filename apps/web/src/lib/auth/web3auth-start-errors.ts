/**
 * The reason a Web3Auth connector failed to START, which the SDK otherwise drops.
 *
 * A redirect sign-in is finished inside the auth connector's `init()`
 * (`@web3auth/auth` `Auth.init`: the `nonce` branch asks Web3Auth's frame for the
 * session, then authorises it). When that throws - the frame answering
 * LOGIN_FAILED, `JSON.parse` of a missing `loginParams`, or the session refusing
 * to authorise (`LoginError.userNotLoggedIn`) - the modal catches it and only
 * LOGS it (`modalManager.initInAppAndCachedConnectors`:
 * `log.error(error, "error while initializing connector ", connectorName)`); no
 * event reaches the page. An iPhone, 2026-10-12, showed exactly that:
 * `W3A-connect-Error-t3-redirect-r.b64-r.nonce-st.ready` - a reason-less code.
 *
 * So, for the length of one build, this taps that log line through the SDK's own
 * PUBLIC logger (`log` from `@web3auth/modal`, a loglevel logger) with
 * loglevel's documented plugin hook (`methodFactory` + `rebuild()`), chained on
 * top of whatever is installed (the SDK's Sentry plugin). Nothing is read but the
 * error object; the log line still prints as before. Pure - no SDK import - so
 * it runs under node:test against the real logger.
 */

/** The slice of a loglevel logger the tap uses. */
export type TappableLog = {
  methodFactory: (methodName: string, level: number, loggerName: string | symbol | undefined) => (...args: unknown[]) => void;
  rebuild(): void;
};

/** The modal's own words for a connector that failed to start (pinned in the tests). */
export const CONNECTOR_INIT_FAILED_LOG = "error while initializing connector";
/** The email/social login's connector (`WALLET_CONNECTORS.AUTH`). */
const AUTH = "auth";

/**
 * Call `onError` with the error the auth connector's start-up threw, if the modal
 * logs one while the tap is on. Returns the off switch: after it, the logger is
 * exactly as it was (or, if something chained on top meanwhile, this layer
 * becomes a pass-through).
 */
export function tapConnectorStartErrors(log: TappableLog, onError: (e: unknown) => void): () => void {
  const prior = log.methodFactory;
  let on = true;
  const ours: TappableLog["methodFactory"] = function (this: unknown, methodName, level, loggerName) {
    const raw = prior.call(this, methodName, level, loggerName);
    if (methodName !== "error") return raw;
    return (...args: unknown[]) => {
      if (on && typeof args[1] === "string" && args[1].trim() === CONNECTOR_INIT_FAILED_LOG && args[2] === AUTH) {
        try {
          onError(args[0]);
        } catch {
          /* a diagnostic never breaks the SDK's logging */
        }
      }
      return raw?.(...args);
    };
  };
  log.methodFactory = ours;
  log.rebuild();
  return () => {
    on = false;
    if (log.methodFactory === ours) {
      log.methodFactory = prior;
      log.rebuild();
    }
  };
}
