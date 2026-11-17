/** Existing frame path composition, with exactly one address read and unchanged caller-slot order. */
export function absolutePath(address: readonly string[], path: readonly string[], key: string): string[] {
  if (address.length === 0) return [...path, key];
  const out = new Array<string>(address.length + path.length + 1);
  for (let i = 0; i < address.length; i++) out[i] = address[i];
  for (let i = 0; i < path.length; i++) out[address.length + i] = path[i];
  out[out.length - 1] = key;
  return out;
}
