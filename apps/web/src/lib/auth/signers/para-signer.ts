import { ParaEthersSigner } from "@getpara/ethers-v6-integration";
import type { EIP712Signer, SigningRequestInfo } from "@woco/shared";
import { para } from "../para-client.js";

/**
 * Create an EIP-712 signer backed by the Para embedded wallet.
 * Shows WoCo's SigningConfirmDialog for explicit user approval before
 * Para signs on their infrastructure — consistent with local/passkey flow.
 */
export function createParaSigner(
  confirmFn: (info: SigningRequestInfo) => Promise<boolean>,
): EIP712Signer {
  // Provider is not needed for EIP-712 signing when domain has no chainId
  const signer = new ParaEthersSigner(para, null as any);

  return async (domain, types, value) => {
    const domainName = (domain.name as string) || "Unknown";
    const typeName = Object.keys(types)[0] || "Unknown";
    const fields: SigningRequestInfo["fields"] = [];
    for (const [key, val] of Object.entries(value)) {
      const str = typeof val === "string" ? val : JSON.stringify(val);
      fields.push({ label: key, value: str.length > 80 ? str.slice(0, 77) + "..." : str });
    }

    const approved = await confirmFn({ action: typeName, domainName, fields });
    if (!approved) {
      throw new Error("Signing cancelled by user");
    }

    return signer.signTypedData(domain as any, types as any, value);
  };
}
