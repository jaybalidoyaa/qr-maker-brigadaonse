/**
 * QR code rendering: SVG (vector, for ID cards/print) and PNG (raster download).
 * The encoded payload is ALWAYS only the verification URL — no record data.
 */

import qrcode from 'qrcode-generator';
import { encodePng } from './png';

export interface QrOptions {
  /** Module size in SVG user units / PNG pixels. */
  cellSize?: number;
  /** Quiet zone in modules (spec requires >= 4). */
  marginModules?: number;
  dark?: string;
  light?: string;
}

function buildMatrix(text: string): { size: number; isDark: (r: number, c: number) => boolean } {
  const qr = qrcode(0, 'M'); // 0 = auto-select smallest fitting version
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return { size, isDark: (r: number, c: number) => qr.isDark(r, c) };
}

/** Standalone SVG document with a quiet zone. */
export function qrToSvg(text: string, options: QrOptions = {}): string {
  const cell = options.cellSize ?? 8;
  const margin = options.marginModules ?? 4;
  const dark = options.dark ?? '#0f172a';
  const light = options.light ?? '#ffffff';
  const { size, isDark } = buildMatrix(text);
  const total = (size + margin * 2) * cell;

  const parts: string[] = [];
  for (let r = 0; r < size; r++) {
    let runStart = -1;
    for (let c = 0; c <= size; c++) {
      const darkCell = c < size && isDark(r, c);
      if (darkCell && runStart === -1) runStart = c;
      if (!darkCell && runStart !== -1) {
        const x = (margin + runStart) * cell;
        const y = (margin + r) * cell;
        const w = (c - runStart) * cell;
        parts.push(`M${x} ${y}h${w}v${cell}h-${w}z`);
        runStart = -1;
      }
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="Verification QR code">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path fill="${dark}" d="${parts.join('')}"/>` +
    `</svg>`
  );
}

/** 8-bit RGB PNG, quiet zone included. */
export function qrToPng(text: string, options: QrOptions = {}): Uint8Array {
  const cell = options.cellSize ?? 8;
  const margin = options.marginModules ?? 4;
  const { size, isDark } = buildMatrix(text);
  const total = (size + margin * 2) * cell;

  const rgb = new Uint8Array(total * total * 3);
  const dark = hexToRgb(options.dark ?? '#0f172a');
  const light = hexToRgb(options.light ?? '#ffffff');

  for (let y = 0; y < total; y++) {
    const moduleRow = Math.floor(y / cell) - margin;
    for (let x = 0; x < total; x++) {
      const moduleCol = Math.floor(x / cell) - margin;
      const inRange = moduleRow >= 0 && moduleRow < size && moduleCol >= 0 && moduleCol < size;
      const isModuleDark = inRange && isDark(moduleRow, moduleCol);
      const color = isModuleDark ? dark : light;
      const idx = (y * total + x) * 3;
      rgb[idx] = color[0];
      rgb[idx + 1] = color[1];
      rgb[idx + 2] = color[2];
    }
  }
  return encodePng(total, total, rgb);
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [15, 23, 42];
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
