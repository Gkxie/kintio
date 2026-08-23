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

export function splitUtf8(text: unknown, maxBytes: number): string[] {
  const value = String(text ?? '');
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');

    if (characterBytes > maxBytes) {
      throw new Error('A single character exceeds the maximum UTF-8 byte size');
    }

    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }

    current += character;
    currentBytes += characterBytes;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}
