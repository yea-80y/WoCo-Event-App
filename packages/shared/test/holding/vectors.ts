/**
 * Shared inputs and GOLDEN outputs for the holding tests. The goldens were computed once
 * from these inputs and are checked here against a second implementation (ethers,
 * node:crypto), and in the contracts repo against Solidity
 * (`test/WoCoHoldingVectors.t.sol`). Change one only together with that test: every
 * receipt already issued depends on them.
 */

import { hexToBytes } from "@noble/hashes/utils.js";

/** r = 0x01 02 .. 20. */
export const R = new Uint8Array(32).map((_, i) => i + 1);

/** WoCoTicketLedger version 2 on Arbitrum One (contracts/deployments/42161-ledger2.json). */
export const TARGET = { chainId: 42161, ledger: "0x5cd8394ef7a4e50403ff72d6addd4582332a6050" };
export const EVENT_ID = `0x${"ab".repeat(32)}`;
export const SLOT = 6;
export const BURNER_KEY = hexToBytes("11".repeat(32));
export const VOID_SIGNER_KEY = hexToBytes("22".repeat(32));
export const AUDIENCE = `0x${"22".repeat(20)}`;
export const CONTEXT = `0x${"cd".repeat(32)}`;
export const T0 = 1_800_000_000;

export const G = {
  holders: [
    "0x8bc7c1c1e49b82b62b4a4fdfebf11141d988a49f",
    "0x358e9f2ae14bd9116f895589f8ce6d39aeddde9e",
    "0xe5f4795398b2f668f884f3250d98148883a6b99e",
  ],
  answerKeys: [
    "0xbee5391e94b4a06c5884999c12b2827271156fc8",
    "0x7e312dd51dbdb6e0af64de9f9a711b9159bfc853",
    "0x5a64cb1cf92ddc17cab54f9a63348d083616718d",
  ],
  holder9: "0x5e304de9e2b255369c3017a05c743da1d210ec73",
  answer9: "0xb912ce0ec71f8c0c52507b149404c0a6c796c338",
  nk: "002743f4d210fe2b727de32606120b28fb3d7d000d7e4337454789382923eda2",
  nkCommit: "0x35c00f5290574ca0e06482cc1203398631ed488c01fad28832a4c2e3aa4e7f7b",
  pickupId: "51e3ae07b949f7ebd89b1729397646d05bb1ad29d1daaa5ac43889c3b375b9bf",
  pickupSigner: "0xaa40c1d180d4a7e153e42ce4f8e5990f25ad4b52",
  pickupPubSha256: "cbce0173214111356ab8141c60083de3e8a967716f6fb0cf36e6ca011d222013",
  receiptDigest: "0xe811a5e21454fdf8ed2d17a0cbaf211a33568a540384eea60045d17030316a2d",
  receiptSig:
    "0x703ec3cea4493403500be2820d7ad40014b58c55e33b373c259106a89e441d2026b23a2d78b2609cc1fb59b3a448fff03716ba97374292c64d58ea9a6be1a7201b",
  presentationDigest: "0xf7bb1d7ce9c4a142325affb93a93fa5b3853115a5a798e6514eb3c29f63aca0b",
  presentationSig:
    "0x815b57018d20bf742cc980b11e09e6dd80902cb8942129c0dd046ed11ba9df0f5dcce6214cf4f0459b5ca99062cb66c54b9424d58155683b2b02b730dc14e8e21c",
  leaves: [
    "0x12f8ea62ec73964994c7caf95e08a568a313f33b5c1e2873d30111278ad2c0cb",
    "0x2659457c836aae627105c4824e5780adfdf64e64c903c8eaf7b40de2e172d0a6",
    "0xd0f958395df68e664c701891e5cd5edf9c1fa70643e816bb1604d446c296178e",
  ],
  root: "0xfe3e6ca753855a9e5e902f219822952888f4e25deaaff98d0bbd01cf033e5a94",
  voidTag: "0x21b1fd5a6f1bf6ddd2953a21d774a9671b8173e8690277fc017e194a228706e9",
  entries: [
    "0x084fed08b978af4d7d196a7446a86b58009e636b611db16211b65a9aadff29c5",
    "0x21b1fd5a6f1bf6ddd2953a21d774a9671b8173e8690277fc017e194a228706e9",
    "0x4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
    "0x67586e98fad27da0b9968bc039a1ef34c939b9b8e523a8bef89d478608c5ecf6",
    "0xca358758f6d27e6cf45272937977a748fd88391db679ceda7dc7bf1f005ee879",
    "0xdbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986",
    "0xe52d9c508c502347344d8c07ad91cbd6068afc75ff6292f062a09ca381c89e71",
    "0xe77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db",
  ],
  entriesHash: "0x6925e1ecbbad7c1fb39b4289563976ff887e674e0d23df5a86624163975bd79f",
  voidListDigest: "0xda70ea4f532cd5297d2a8aa7729f37ff10092260dae1042e3b725d4eb1ee3712",
  voidListSig:
    "0x6c8b023ad9126953932792c09c383c02df4af0331915758a78468fdd03fa84e058a3db1b9a1c0dda4eaf37cd1d66b79fe12e4e715f65b832d35d431eb2608a861c",
  eraseDigest: "0x9eb284a31e1e97929cccb55d53dd65ee3876221bcaebba3d7d8913f5a4e74cf0",
  eraseSig:
    "0x65e3530a1214e0a3ea0a3c0bcda8b67e7da2b85c9fcc702735b79a6590d8c75f2bde145c190c1570b1ea4c7a6627a8ca4778ba2ff548886a46bb1926d0dcbdf11b",
  keep: "#/keep?k=AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA&b=efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
};

/** The receipt the vectors sign: ticket 0 of the order, in slot 6. */
export const HOLDING = { eventId: EVENT_ID, slot: SLOT, holder: G.holders[0]!, answerKey: G.answerKeys[0]!, nkCommit: G.nkCommit };

export const PRESENTATION = { receipt: G.receiptDigest, audience: AUDIENCE, context: CONTEXT, issuedAt: T0, expiresAt: T0 + 86_400 };

/** The padding the void vector used: sha256 of a counter, so the dummies are reproducible. */
export async function counterRandom(): Promise<(n: number) => Uint8Array> {
  const { sha256 } = await import("@noble/hashes/sha2.js");
  let ctr = 0;
  return (n: number) => {
    ctr++;
    return sha256(new Uint8Array([ctr])).slice(0, n);
  };
}
