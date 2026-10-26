/**
 * Minimal dependency-free PNG encoder (8-bit RGB, no interlace).
 * Emits a valid zlib stream built from stored (uncompressed) DEFLATE blocks,
 * which keeps rendering deterministic across environments.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

/** zlib stream (RFC 1950) wrapping stored DEFLATE blocks (RFC 1951). */
function zlibStored(raw: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  const MAX = 65535;
  const blockCount = Math.max(1, Math.ceil(raw.length / MAX));
  for (let i = 0; i < blockCount; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, raw.length - start);
    const final = i === blockCount - 1 ? 1 : 0;
    const header = new Uint8Array([
      final,
      len & 0xff,
      (len >>> 8) & 0xff,
      (~len) & 0xff,
      ((~len) >>> 8) & 0xff,
    ]);
    parts.push(header, raw.subarray(start, start + len));
  }
  parts.push(u32(adler32(raw)));
  return concat(parts);
}

/**
 * @param rgb flat RGB buffer, length must be width * height * 3
 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  if (rgb.length !== width * height * 3) {
    throw new Error(`encodePng: expected ${width * height * 3} bytes, got ${rgb.length}`);
  }

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = concat([
    u32(width),
    u32(height),
    new Uint8Array([8, 2, 0, 0, 0]), // 8-bit, truecolour RGB, deflate, adaptive, no interlace
  ]);

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
