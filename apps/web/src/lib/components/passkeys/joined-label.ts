/**
 * What the new device shows as the account it joined. Address first: the name is
 * free text the joined account chose, so it may never stand where the address
 * does, and a name that itself looks like an address is dropped (#936).
 */
export function joinedAccountLabel(address: string, name: string | null): string {
  return name && !/0x[0-9a-f]{2,}|…/i.test(name) ? `${address} (${name})` : address;
}
