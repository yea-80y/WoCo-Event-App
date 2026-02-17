import { Wallet } from "ethers";
import type { EIP712Signer, SigningRequestInfo } from "@woco/shared";

/**
 * Create an EIP-712 signer that signs locally with a private key.
 * Shows a confirmation dialog before each signature via the confirmFn callback.
 */
export function createLocalSigner(
  privateKey: string,
  confirmFn: (info: SigningRequestInfo) => Promise<boolean>,
): EIP712Signer {
  const wallet = new Wallet(privateKey);

  return async (domain, types, value) => {
    // Build human-readable info for the confirmation dialog
    const domainName = (domain.name as string) || "Unknown";
    const typeName = Object.keys(types)[0] || "Unknown";
    const fields: SigningRequestInfo["fields"] = [];
    for (const [key, val] of Object.entries(value)) {
      const str = typeof val === "string" ? val : JSON.stringify(val);
      // Truncate long values for display
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
