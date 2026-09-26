import { describe, expect, it } from 'vitest';
import { imageSize } from './image-size.js';

/** Headers built by hand to the format specifications, with the sizes chosen by the test. */

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to walk past, then SOF0 with the frame size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('reading an image size from its header', () => {
  it('reads PNG', () => expect(imageSize(png(180, 60))).toEqual({ width: 180, height: 60 }));
  it('reads GIF', () => expect(imageSize(gif(32, 32))).toEqual({ width: 32, height: 32 }));
  it('reads JPEG, past the segments before the frame', () =>
    expect(imageSize(jpeg(1080, 640))).toEqual({ width: 1080, height: 640 }));
  it('reads WebP', () => expect(imageSize(webpVp8x(200, 50))).toEqual({ width: 200, height: 50 }));

  it('says it does not know rather than guessing', () => {
    expect(imageSize(Buffer.from('%PDF-1.7 not an image'))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    // A PNG signature with the header cut off.
    expect(imageSize(png(10, 10).subarray(0, 18))).toBeNull();
    // A JPEG whose segment length runs off the end.
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]))).toBeNull();
  });
});
