import { ValueTableError } from './types.js';

/** Browser WebCrypto only. A timeout bounds waiting; the platform computation cannot be cancelled. */
export async function valueDigest(text: string, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refusal: 'crypto-unavailable' | 'digest-timeout' | 'digest-failed' = 'digest-failed';
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      refusal = 'crypto-unavailable';
      throw new ValueTableError(refusal);
    }
    const pending = subtle.digest('SHA-256', new TextEncoder().encode(text));
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        refusal = 'digest-timeout';
        reject(new ValueTableError(refusal));
      }, timeoutMs);
    });
    const result = await Promise.race([pending, timeout]);
    const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
    if (!byteLength || byteLength.call(result) !== 32) throw new ValueTableError('digest-failed');
    return 'sha256:' + Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new ValueTableError(refusal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
