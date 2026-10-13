/**
 * The feed a bee feed manifest follows, read from its root chunk STRICTLY (#186).
 *
 * A name's content hash is a feed manifest: a mantaray v0.2 node with ONE fork, "/",
 * whose metadata names the feed. Bee resolves the manifest through that fork, so the
 * answer here must be read exactly the way bee reads it - not by finding feed-looking
 * JSON somewhere in the bytes, which a crafted manifest could carry while bee follows
 * another fork. Anything but the shape bee makes is refused: one fork, prefix "/",
 * metadata exactly `{"swarm-feed-owner","swarm-feed-topic","swarm-feed-type":"Sequence"}`
 * as bee writes it (compact, keys in order), and nothing after it.
 *
 * Layout (bee-js `MantarayNode.marshal`, which bee reads): obfuscation key (32) then,
 * XORed with it: version hash (31), target length (1), target, fork bitmap (32, bit i
 * LE = first byte i), and per fork: type (1), prefix length (1), prefix padded to 30,
 * the child's address (32), and with metadata a 2-byte big-endian length and the JSON
 * padded with newlines.
 */

const VERSION_02 = "5768b3b6a7db56d21d1abff40d41cebfc83448fed8d7e9b06ec0d3b073f28f";
const TYPE_WITH_METADATA = 16;
const SLASH = 47;
const ADDRESS_BYTES = 32;

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** The feed (lowercase, no `0x`) a feed manifest root chunk (span + payload) follows, or null. */
export function feedOfManifestChunk(chunk: Uint8Array): { owner: string; topic: string } | null {
  if (chunk.length < 8 + 32 + 32) return null;
  let span = 0;
  for (let i = 7; i >= 0; i--) span = span * 256 + chunk[i]!;
  const payload = chunk.subarray(8);
  if (span !== payload.length) return null;
  const key = payload.subarray(0, 32);
  const d = payload.subarray(32).map((b, i) => b ^ key[i % 32]!);
  let o = 0;
  const take = (n: number): Uint8Array => {
    if (o + n > d.length) throw new Error("short");
    const s = d.subarray(o, o + n);
    o += n;
    return s;
  };
  try {
    if (hex(take(31)) !== VERSION_02) return null;
    const targetLength = take(1)[0]!;
    if (targetLength !== 0 && targetLength !== ADDRESS_BYTES) return null;
    take(targetLength);
    const bitmap = take(32);
    for (let i = 0; i < 256; i++) {
      if (((bitmap[i >> 3]! >> (i & 7)) & 1) !== (i === SLASH ? 1 : 0)) return null;
    }
    if ((take(1)[0]! & TYPE_WITH_METADATA) === 0) return null;
    if (take(1)[0] !== 1) return null;
    const prefix = take(30);
    if (prefix[0] !== SLASH || prefix.subarray(1).some((b) => b !== 0)) return null;
    take(ADDRESS_BYTES);
    const lengthBytes = take(2);
    const meta = take((lengthBytes[0]! << 8) | lengthBytes[1]!);
    if (o !== d.length) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(meta).replace(/\n+$/, "");
    const m = JSON.parse(text) as Record<string, unknown>;
    const owner = m["swarm-feed-owner"];
    const topic = m["swarm-feed-topic"];
    if (typeof owner !== "string" || !/^[0-9a-f]{40}$/.test(owner)) return null;
    if (typeof topic !== "string" || !/^[0-9a-f]{64}$/.test(topic)) return null;
    // Exactly bee's text: no other key, no repeated one, nothing two JSON readers could read apart.
    if (text !== JSON.stringify({ "swarm-feed-owner": owner, "swarm-feed-topic": topic, "swarm-feed-type": "Sequence" })) return null;
    return { owner, topic };
  } catch {
    return null;
  }
}
