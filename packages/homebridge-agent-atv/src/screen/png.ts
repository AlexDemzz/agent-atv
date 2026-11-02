const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the IHDR chunk, or null when `data` isn't a PNG. */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(SIGNATURE)) return null;
  if (data.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Width and height from the first SOF segment, or null when `data` isn't a JPEG. */
export function jpegSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= data.length && data[at] === 0xff) {
    const marker = data[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (SOF.has(marker)) {
      if (at + 9 > data.length) return null;
      return { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
    }
    at += 2 + data.readUInt16BE(at + 2);
  }
  return null;
}
