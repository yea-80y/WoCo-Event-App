/**
 * Opens the share sheet from anywhere — the tab bar's Invite key, Home's
 * "Show my code", Contacts' Invite to host and Follow me — without any of them
 * owning it. The member shell mounts the sheet, and loads the QR library, only
 * while this is open.
 */

export type ShareStart = "invite" | "follow";

let _open = $state(false);
let _start = $state<ShareStart>("invite");

export const inviteSheet = {
  get open() { return _open; },
  /** The code the sheet opens on. */
  get start() { return _start; },
  show(start: ShareStart = "invite"): void {
    _start = start;
    _open = true;
  },
  hide(): void { _open = false; },
};
