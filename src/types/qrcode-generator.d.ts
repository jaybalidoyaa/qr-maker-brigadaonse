declare module 'qrcode-generator' {
  interface QRCode {
    addData(data: string, mode?: 'Numeric' | 'Alphanumeric' | 'Byte' | 'Kanji'): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
    createSvgTag(cellSize?: number, margin?: number): string;
    createTableTag(cellSize?: number, margin?: number): string;
    createDataURL(cellSize?: number, margin?: number): string;
  }

  interface QRCodeFactory {
    (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H'): QRCode;
    stringToBytes(s: string): number[];
    implementations: unknown[];
  }

  const qrcode: QRCodeFactory;
  export default qrcode;
}
