/**
 * The Rita 100 pilot's subject, as a literal.
 *
 * WHY IT IS COPIED RATHER THAN IMPORTED. `vite.count.config.ts` bakes this into
 * the generated `overlay.html`, and a vite config is loaded by Node before any
 * TypeScript resolution is set up — `@woco/shared` ships raw TS behind `.js`
 * import specifiers, so importing `RITA_SUBJECT` there fails outright. A local
 * literal is the only thing the config can read.
 *
 * WHY IT CANNOT DRIFT. `test/pilot-subject.test.ts` recomputes it from Rita's
 * PERMANENT id and fails if the two differ. It is deliberately not pinned to
 * the `RITA_SUBJECT` alias, which is positional — inserting any coaster ahead
 * of Rita in `WOCO_SUBJECT_DEFINITIONS` redefines that alias, and a test
 * anchored to it would fail telling you to repoint the live overlay at
 * whatever now sits at index 0. A subject hash is permanent by construction —
 * it is what riders sign against — so the id is the thing to hold on to.
 */

export const RITA_SUBJECT_HASH =
  "0xf1b7f5115cfaf052619cad0d34ae3a26425e8a6d84647120174bf33f261b201b";
