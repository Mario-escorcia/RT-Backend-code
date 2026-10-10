/** Lowercase, accent-free, single-spaced version of a topic, used to group repeated searches. */
export function normalizeTopic(topic: string): string {
  return topic
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[\p{Lu}¿¡"«(])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function firstSentences(text: string, count: number, maxLength: number): string {
  return truncate(splitSentences(text).slice(0, count).join(' '), maxLength);
}

export function paragraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function compactNumber(value: number, lang: 'es' | 'en'): string {
  return new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}
