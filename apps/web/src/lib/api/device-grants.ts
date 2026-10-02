/** `/api/auth/device-grants` (#746): the signed statements; the browser checks them. */

import type { ApiResponse, DeviceGrantMessage, DeviceGrantRevokeMessage, SessionRank } from "@woco/shared";
import { authGet, authPost } from "./client.js";
import type { DeviceGrantRecordWire } from "../auth/device-grant-verify.js";

export function listDeviceGrants(): Promise<ApiResponse<{ grants: DeviceGrantRecordWire[]; sessionRank: SessionRank }>> {
  return authGet("/api/auth/device-grants");
}

export function registerDeviceGrant(grant: DeviceGrantMessage, grantSig: string): Promise<ApiResponse<unknown>> {
  return authPost("/api/auth/device-grants", { grant, grantSig });
}

export function revokeDeviceGrant(revoke: DeviceGrantRevokeMessage, revokeSig: string): Promise<ApiResponse<unknown>> {
  return authPost("/api/auth/device-grants/revoke", { revoke, revokeSig });
}
