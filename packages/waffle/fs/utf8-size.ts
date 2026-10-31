/** TextEncoder byte length without materializing the encoded bytes. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit < 0x80) {
      bytes++;
      continue;
    }
    if (unit < 0x800) {
      bytes += 2;
      continue;
    }
    const next = text.charCodeAt(at + 1);
    if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 4;
      at++;
      continue;
    }
    bytes += 3;
  }
  return bytes;
}
