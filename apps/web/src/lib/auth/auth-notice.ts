/** One-shot sign-out explanation; sessionStorage, read + cleared by the login modal.
 *  Lives alone: the eagerly-mounted LoginModal needs this key, but importing it
 *  from envelope-reprobe.ts would hoist that deliberately-lazy module into the
 *  entry chunk — Vite cannot code-split a module that is imported both ways. */
export const AUTH_NOTICE_KEY = "woco:auth-notice";
