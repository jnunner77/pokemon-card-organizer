import QRCode from 'qrcode';
import type { QrCodes } from '#application/guests/ports.ts';

/** QR codes from the qrcode package (until the request pipeline PBI replaces it). */
export class QrSvg implements QrCodes {
  svg(text: string): Promise<string> {
    return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  }
}
