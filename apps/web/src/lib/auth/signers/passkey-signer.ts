import type { EIP712Signer, SigningRequestInfo } from "@woco/shared";

/**
 * Create an EIP-712 signer that signs with a passkey-derived private key.
 * Shows a confirmation dialog before each signature so the user can inspect
 * what they're approving. ethers is imported lazily so signer factories stay
 * off the boot path.
 */
export function createPasskeySigner(
  privateKey: string,
  confirmFn: (info: SigningRequestInfo) => Promise<boolean>,
): EIP712Signer {
  return async (domain, types, value) => {
    const { Wallet } = await import("ethers");
    const wallet = new Wallet(privateKey);
    const domainName = (domain.name as string) || "Unknown";
    const typeName = Object.keys(types)[0] || "Unknown";
    const fields: SigningRequestInfo["fields"] = [];
    for (const [key, val] of Object.entries(value)) {
      const str = typeof val === "string" ? val : JSON.stringify(val);
      fields.push({ label: key, value: str.length > 80 ? str.slice(0, 77) + "..." : str });
    }

    const approved = await confirmFn({
      action: typeName,
      domainName,
      fields,
    });

    if (!approved) {
      throw new Error("Signing cancelled by user");
    }

    return wallet.signTypedData(domain, types, value);
  };
}
