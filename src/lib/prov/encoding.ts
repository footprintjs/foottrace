/** Exact UTF-8 size of owned, well-formed JSON text, including stringify's escaping. */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? (index++, 4) : 3;
  }
  return bytes;
}
