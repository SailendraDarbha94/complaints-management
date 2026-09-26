/**
 * An image's size in pixels, read from its header. PNG, GIF, JPEG and WebP; null for
 * anything else, and for anything malformed - a caller must treat null as "don't know".
 *
 * It exists to tell a signature logo from a screenshot. File size alone cannot: a crop of a
 * UPI payment confirmation pasted into a complaint weighs about what a logo does, and
 * classing it as a logo hides the complainant's proof of payment. Its SHAPE differs - a
 * logo is a couple of hundred pixels at most, a screenshot is as wide as a screen.
 */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  try {
    // PNG: the IHDR chunk comes first, with width and height as big-endian 32-bit.
    if (b.length >= 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' &&
        b.toString('latin1', 12, 16) === 'IHDR') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }

    // GIF: 'GIF87a' or 'GIF89a', then the logical screen size, little-endian 16-bit.
    if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }

    // JPEG: walk the segments to the first start-of-frame marker, which holds the size.
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        if (marker === 0xff) {
          i++; // fill byte
          continue;
        }
        // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        // Markers with no length field.
        if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
          i += 2;
          continue;
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }

    // WebP: a RIFF container, then one of three kinds of first chunk.
    if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8X') {
        return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      }
      if (chunk === 'VP8 ') {
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
    }
  } catch {
    // A header that claims more bytes than there are. Not knowing is the honest answer.
    return null;
  }
  return null;
}
