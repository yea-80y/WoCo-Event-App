/** MOVED into `issuance.ts`, where POD issuance already lives. This shim exists
 *  only because the file could not be removed in the same pass; delete both. */
export { validateIssuedCount, type IssuedCountVerdict } from "./issuance.js";
