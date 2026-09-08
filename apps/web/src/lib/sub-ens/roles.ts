/**
 * What a `.woco.eth` name is FOR, and which names a picker may offer.
 *
 * The server answers `GET /api/sub-ens/owned` with a `role` per name because a
 * name's on-chain record cannot say this: `ownerOf` tells you who holds it,
 * never whether it is that account's identity or the address of a site. The
 * PROFILE name is the one role with a consequence — every binding point
 * (`stamp-event`, `set-contenthash`, the site deploy hook) refuses it with a
 * 409 `profile_name`. Offering it in a picker is therefore offering a click
 * that cannot succeed, which is what #484 caught.
 *
 * Pure: no fetch, no DOM, no `Date`. The list type is structural so this module
 * does not pull the API client (and its auth store) into a node test.
 */

/** Roles as `GET /api/sub-ens/owned` sends them. */
export type SubEnsNameRole = "profile" | "url" | "free";

/** The shape this module needs — anything carrying a role. */
export interface RoledName {
  role?: SubEnsNameRole;
}

/**
 * The names a site or event may be bound to: everything that is not the
 * account's profile name.
 *
 * A name whose role is ABSENT is kept. An older server (or a cached response
 * from one) sends no role at all, and dropping those would empty the picker for
 * everyone mid-deploy — the wrong failure direction for a filter whose only job
 * is to hide one row.
 */
export function bindableNames<T extends RoledName>(names: readonly T[]): T[] {
  return names.filter((n) => n.role !== "profile");
}

/** True when the list contains a profile name — i.e. {@link bindableNames} hid a row. */
export function hidesProfileName(names: readonly RoledName[]): boolean {
  return names.some((n) => n.role === "profile");
}

/**
 * The role as a person reads it, or `undefined` when the server did not send
 * one — the caller then keeps whatever it showed before rather than printing a
 * blank line.
 */
export function roleLabel(role: SubEnsNameRole | undefined): string | undefined {
  switch (role) {
    case "profile": return "profile name";
    case "url":     return "site address";
    case "free":    return "not pointed anywhere yet";
    default:        return undefined;
  }
}
