import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';
import { create, toBuffer } from 'qrcode';

const MAX_QR_CONTENT_BYTES = 2_048;
const MAX_QR_PNG_BYTES = 512 * 1_024;
const CARD_WIDTH = 720;
const CARD_HEIGHT = 1_024;
const QR_REGION_X = 120;
const QR_REGION_Y = 220;
const QR_REGION_SIZE = 480;
const QUIET_ZONE_MODULES = 4;
const RAW_QR_SCALE = 6;
const QR_DARK = Object.freeze([0x11, 0x18, 0x14, 0xff] as const);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const TERMINAL_INK = '\u001b[47m\u001b[30m';
const TERMINAL_RESET = '\u001b[0m';

function templatePath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.resolve(
    moduleDirectory,
    '../../assets/ilink-login-card.png',
  );
  return fs.existsSync(sourcePath)
    ? sourcePath
    : path.resolve(moduleDirectory, '../../../assets/ilink-login-card.png');
}

function readTemplate(): Readonly<{ width: number; height: number; data: Buffer }> {
  const template = PNG.sync.read(fs.readFileSync(templatePath()));
  if (template.width !== CARD_WIDTH || template.height !== CARD_HEIGHT) {
    throw new Error('iLink login card template has invalid dimensions');
  }
  return Object.freeze({
    width: template.width,
    height: template.height,
    data: Buffer.from(template.data),
  });
}

const CARD_TEMPLATE = readTemplate();

export type IlinkQrRenderErrorCode =
  | 'invalid_qr_content'
  | 'qr_render_failed'
  | 'invalid_qr_png'
  | 'qr_png_too_large';

export class IlinkQrRenderError extends Error {
  readonly code: IlinkQrRenderErrorCode;

  constructor(code: IlinkQrRenderErrorCode, message: string) {
    super(message);
    this.name = 'IlinkQrRenderError';
    this.code = code;
  }
}

export interface IlinkTerminalQr {
  readonly text: string;
  readonly columns: number;
  readonly rows: number;
}

export function assertIlinkQrContent(content: string): void {
  if (
    typeof content !== 'string' ||
    content.trim().length === 0 ||
    Buffer.byteLength(content, 'utf8') > MAX_QR_CONTENT_BYTES
  ) {
    throw new IlinkQrRenderError(
      'invalid_qr_content',
      'Invalid iLink QR content',
    );
  }
}

function paintModule(
  image: PNG,
  x: number,
  y: number,
  scale: number,
): void {
  for (let row = 0; row < scale; row += 1) {
    for (let column = 0; column < scale; column += 1) {
      const offset = ((y + row) * image.width + x + column) * 4;
      image.data[offset] = QR_DARK[0];
      image.data[offset + 1] = QR_DARK[1];
      image.data[offset + 2] = QR_DARK[2];
      image.data[offset + 3] = QR_DARK[3];
    }
  }
}

function renderCard(content: string): Buffer {
  const qr = create(content, { errorCorrectionLevel: 'M' });
  const matrixSize = qr.modules.size;
  const totalModules = matrixSize + QUIET_ZONE_MODULES * 2;
  const scale = Math.floor(QR_REGION_SIZE / totalModules);
  if (scale < 1) throw new Error('iLink QR matrix exceeds the card region');
  const renderedSize = totalModules * scale;
  const matrixX = QR_REGION_X + Math.floor((QR_REGION_SIZE - renderedSize) / 2)
    + QUIET_ZONE_MODULES * scale;
  const matrixY = QR_REGION_Y + Math.floor((QR_REGION_SIZE - renderedSize) / 2)
    + QUIET_ZONE_MODULES * scale;
  const image = new PNG({ width: CARD_TEMPLATE.width, height: CARD_TEMPLATE.height });
  CARD_TEMPLATE.data.copy(image.data);

  for (let row = 0; row < matrixSize; row += 1) {
    for (let column = 0; column < matrixSize; column += 1) {
      if (qr.modules.get(row, column)) {
        paintModule(
          image,
          matrixX + column * scale,
          matrixY + row * scale,
          scale,
        );
      }
    }
  }

  return PNG.sync.write(image, {
    colorType: 6,
    inputColorType: 6,
    bitDepth: 8,
    inputHasAlpha: true,
    deflateLevel: 9,
    deflateStrategy: 3,
  });
}

export async function renderIlinkQrPng(content: string): Promise<Buffer> {
  assertIlinkQrContent(content);
  let png: Buffer;
  try {
    png = renderCard(content);
  } catch {
    throw new IlinkQrRenderError(
      'qr_render_failed',
      'Unable to render iLink QR image',
    );
  }
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new IlinkQrRenderError('invalid_qr_png', 'Rendered iLink QR image is invalid');
  }
  if (png.length > MAX_QR_PNG_BYTES) {
    throw new IlinkQrRenderError('qr_png_too_large', 'Rendered iLink QR image is too large');
  }
  return png;
}

export async function renderIlinkRawQrPng(content: string): Promise<Buffer> {
  assertIlinkQrContent(content);
  let png: Buffer;
  try {
    png = await toBuffer(content, {
      errorCorrectionLevel: 'M',
      margin: QUIET_ZONE_MODULES,
      scale: RAW_QR_SCALE,
      type: 'png',
      color: {
        dark: '#111814ff',
        light: '#ffffffff',
      },
    });
  } catch {
    throw new IlinkQrRenderError(
      'qr_render_failed',
      'Unable to render iLink QR image',
    );
  }
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new IlinkQrRenderError('invalid_qr_png', 'Rendered iLink QR image is invalid');
  }
  if (png.length > MAX_QR_PNG_BYTES) {
    throw new IlinkQrRenderError('qr_png_too_large', 'Rendered iLink QR image is too large');
  }
  return png;
}

export function renderIlinkQrTerminal(content: string): IlinkTerminalQr {
  assertIlinkQrContent(content);
  let qr: ReturnType<typeof create>;
  try {
    qr = create(content, { errorCorrectionLevel: 'M' });
  } catch {
    throw new IlinkQrRenderError(
      'qr_render_failed',
      'Unable to render iLink QR code',
    );
  }
  const matrixSize = qr.modules.size;
  const columns = matrixSize + QUIET_ZONE_MODULES * 2;
  const rows = Math.ceil(columns / 2);
  const dark = (row: number, column: number): boolean => {
    const matrixRow = row - QUIET_ZONE_MODULES;
    const matrixColumn = column - QUIET_ZONE_MODULES;
    return (
      matrixRow >= 0 && matrixRow < matrixSize &&
      matrixColumn >= 0 && matrixColumn < matrixSize &&
      Boolean(qr.modules.get(matrixRow, matrixColumn))
    );
  };
  const lines: string[] = [];
  for (let row = 0; row < columns; row += 2) {
    let line = TERMINAL_INK;
    for (let column = 0; column < columns; column += 1) {
      const top = dark(row, column);
      const bottom = dark(row + 1, column);
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    lines.push(`${line}${TERMINAL_RESET}`);
  }
  return Object.freeze({
    text: `${lines.join('\n')}\n`,
    columns,
    rows,
  });
}
