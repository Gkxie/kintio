export function truncateUtf8(
  text: unknown,
  maxBytes: number,
  suffix = '',
): string {
  const value = String(text ?? '');

  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const contentLimit = Math.max(0, maxBytes - suffixBytes);
  let result = '';
  let resultBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');

    if (resultBytes + characterBytes > contentLimit) {
      break;
    }

    result += character;
    resultBytes += characterBytes;
  }

  return result + suffix;
}
