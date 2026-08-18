/**
 * The Rita 100 pilot's subject, as a literal.
 *
 * WHY IT IS COPIED RATHER THAN IMPORTED. `vite.count.config.ts` bakes this into
 * the generated `overlay.html`, and a vite config is loaded by Node before any
 * TypeScript resolution is set up — `@woco/shared` ships raw TS behind `.js`
 * import specifiers, so importing `RITA_SUBJECT` there fails outright. A local
 * literal is the only thing the config can read.
 *
 * WHY IT CANNOT DRIFT. `test/pilot-subject.test.ts` imports the real
 * `RITA_SUBJECT` from the registry and fails if the two ever differ. The test
 * runs under tsx, where the shared package resolves normally, so the
 * constraint is checked in the one place that can check it. A subject hash is
 * permanent by construction — it is what riders sign against — so this is a
 * value that should never change; the test is there for the day somebody
 * assumes it can.
 */

export const RITA_SUBJECT_HASH =
  "0xf1b7f5115cfaf052619cad0d34ae3a26425e8a6d84647120174bf33f261b201b";
