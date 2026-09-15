/**
 * Opens the invite sheet from anywhere — the tab bar's Invite key and Home's
 * "Show my code" — without either owning it. The member shell mounts the sheet,
 * and loads the QR library, only while this is open.
 */

let _open = $state(false);

export const inviteSheet = {
  get open() { return _open; },
  show(): void { _open = true; },
  hide(): void { _open = false; },
};
