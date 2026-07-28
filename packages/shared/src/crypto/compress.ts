/**
 * Gzip helpers over the native CompressionStream API.
 *
 * Used on the seal path for payloads that grow with a user's data (marketing
 * lists). JSON arrays-of-objects repeat every key on every row, so gzip cuts
 * them by 5-20x — enough that a 20k-contact list fits the sealed-blob cap with
 * room for far more fields per contact. See `sealJsonCompressed`.
 */

/** CompressionStream is baseline-2023; older engines fall back to no compression. */
export function compressionSupported(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

// The DOM lib types the writable side as BufferSource, so the stream is taken as
// the concrete pair rather than a TransformStream<Uint8Array, Uint8Array>.
async function pump(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer: @noble returns Uint8Array<ArrayBufferLike>,
  // which the stream's BufferSource parameter rejects (same reason as ecies.buf).
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);

  const writer = stream.writable.getWriter();
  void writer.write(owned);
  void writer.close();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new CompressionStream("gzip"));
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return pump(bytes, new DecompressionStream("gzip"));
}

/**
 * Gzip magic number (0x1f 0x8b). Serialised JSON always starts with `{`, `[` or
 * whitespace, so this byte pair can never collide with an uncompressed payload —
 * which is what lets `openJsonAuto` read blobs sealed before compression existed.
 */
export function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
