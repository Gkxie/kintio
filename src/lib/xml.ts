export function extractXmlTag(xml: string, tagName: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_:-]*$/.test(tagName)) {
    throw new Error('Invalid XML tag name');
  }

  const expression = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tagName}>`,
    'i',
  );
  const match = expression.exec(xml);

  return match ? (match[1] ?? match[2] ?? '').trim() : '';
}
