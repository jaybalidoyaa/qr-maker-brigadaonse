import { describe, expect, it } from 'vitest';
import { qrToPng, qrToSvg } from '../src/qr';
import { encodePng } from '../src/png';

const URL_PAYLOAD = 'https://verify.brigadaonse.org/verify/aB3x9_K2mQ7pL0sT5uW8yZ1cE4gH6jN0rV';

function readChunk(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset);
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
  return { length, type, dataStart: offset + 8, headerEnd: offset + 8 + length + 4 };
}

describe('PNG encoder', () => {
  it('emits a valid PNG signature, IHDR and IEND', () => {
    const width = 4;
    const height = 3;
    const rgb = new Uint8Array(width * height * 3).fill(128);
    const png = encodePng(width, height, rgb);

    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdr = readChunk(png, 8);
    expect(ihdr.type).toBe('IHDR');
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(ihdr.dataStart)).toBe(width);
    expect(view.getUint32(ihdr.dataStart + 4)).toBe(height);
    expect(png[ihdr.dataStart + 8]).toBe(8); // bit depth
    expect(png[ihdr.dataStart + 9]).toBe(2); // truecolour RGB

    const idat = readChunk(png, ihdr.headerEnd);
    expect(idat.type).toBe('IDAT');
    // zlib header for 32K window, no compression
    expect(png[idat.dataStart]).toBe(0x78);

    const iend = readChunk(png, idat.headerEnd);
    expect(iend.type).toBe('IEND');
    expect(iend.headerEnd).toBe(png.length);
  });

  it('rejects mismatched buffer sizes', () => {
    expect(() => encodePng(2, 2, new Uint8Array(10))).toThrow();
  });

  it('handles images larger than one stored DEFLATE block', () => {
    // 300x300x3 = 270000 bytes > 65535
    const png = encodePng(300, 300, new Uint8Array(300 * 300 * 3));
    expect(png.length).toBeGreaterThan(270000);
    expect(String.fromCharCode(...png.subarray(12, 16))).toBe('IHDR');
  });
});

describe('QR rendering', () => {
  it('produces a standalone SVG with a quiet zone and a single path', () => {
    const svg = qrToSvg(URL_PAYLOAD, { cellSize: 8, marginModules: 4 });
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('<path fill=');
    // quiet zone: 4 modules on each side
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    expect(viewBox).toBeTruthy();
    const size = Number(viewBox![1]);
    expect(size % 8).toBe(0);
    expect(size).toBeGreaterThan(8 * 8);
  });

  it('encodes only the verification URL payload', () => {
    // Different payloads must yield different artwork; same payload is stable.
    const a = qrToSvg(URL_PAYLOAD);
    const b = qrToSvg(URL_PAYLOAD);
    const c = qrToSvg('https://verify.brigadaonse.org/verify/OTHER_TOKEN_VALUE_12345');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('renders a PNG whose dimensions match the QR matrix plus quiet zone', () => {
    const cell = 10;
    const png = qrToPng(URL_PAYLOAD, { cellSize: cell, marginModules: 4 });
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    expect(width).toBe(height);
    expect(width % cell).toBe(0);
    expect(width).toBeGreaterThanOrEqual((21 + 8) * cell); // version 1 minimum + quiet zone
    // signature
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });

  it('renders printable black-on-white artwork by default', () => {
    const svg = qrToSvg(URL_PAYLOAD);
    expect(svg).toContain('#ffffff');
    expect(svg).toContain('#0f172a');
  });
});
