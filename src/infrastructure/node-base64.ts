import type { Base64 } from '#application/ports.ts';

export class NodeBase64 implements Base64 {
  encode(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }

  decode(text: string): Uint8Array {
    return Buffer.from(text, 'base64');
  }
}
