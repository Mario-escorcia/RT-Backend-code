import { fetchJson } from '../../lib/http.js';
import { paragraphs } from '../../lib/text.js';
import type { InterestData, Lang, WikipediaInfo } from './types.js';

export interface WikiArticle extends WikipediaInfo {
  intro: string;
  sections: { heading: string; text: string }[];
  related: string[];
}

const SKIPPED_SECTIONS =
  /^(referencias|references|véase también|vease tambien|see also|enlaces externos|external links|bibliografía|bibliography|notas|notes|further reading|lecturas adicionales|lectura adicional|fuentes|sources|galería|gallery|citations|footnotes|works cited|obras|filmografía|discografía)$/i;

interface SearchResponse {
  query?: { search?: { title: string }[] };
}

interface PageResponse {
  query?: {
    pages?: {
      title: string;
      missing?: boolean;
      extract?: string;
      description?: string;
      fullurl?: string;
      thumbnail?: { source: string };
      langlinks?: { lang: string; title: string }[];
    }[];
  };
}

interface PageviewsResponse {
  items?: { timestamp: string; views: number }[];
}

function apiUrl(lang: Lang, params: Record<string, string>): string {
  return `https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
}

/** Splits a plain-text extract (exsectionformat=wiki) into intro + top-level sections. */
function splitSections(extract: string): { intro: string; sections: { heading: string; text: string }[] } {
  const headingPattern = /^(={2,6})\s*(.+?)\s*\1\s*$/;
  const sections: { heading: string; level: number; lines: string[] }[] = [];
  const introLines: string[] = [];

  for (const line of extract.split('\n')) {
    const match = headingPattern.exec(line.trim());
    if (match) {
      sections.push({ heading: match[2], level: match[1].length, lines: [] });
    } else if (sections.length) {
      sections[sections.length - 1].lines.push(line);
    } else {
      introLines.push(line);
    }
  }

  // Merge sub-sections into their level-2 parent.
  const merged: { heading: string; text: string }[] = [];
  for (const section of sections) {
    const text = section.lines.join('\n').trim();
    if (section.level === 2 || !merged.length) {
      merged.push({ heading: section.heading, text });
    } else if (text) {
      const parent = merged[merged.length - 1];
      parent.text = `${parent.text}\n${text}`.trim();
    }
  }

  return {
    intro: introLines.join('\n').trim(),
    sections: merged.filter((section) => section.text.length > 80 && !SKIPPED_SECTIONS.test(section.heading)),
  };
}

async function lookup(topic: string, lang: Lang, signal?: AbortSignal): Promise<WikiArticle | null> {
  const search = await fetchJson<SearchResponse>(
    apiUrl(lang, { action: 'query', list: 'search', srsearch: topic, srlimit: '7', srprop: '' }),
    { signal },
  );
  const hits = search.query?.search ?? [];
  if (!hits.length) return null;

  const details = await fetchJson<PageResponse>(
    apiUrl(lang, {
      action: 'query',
      prop: 'extracts|langlinks|pageimages|info|description',
      titles: hits[0].title,
      explaintext: '1',
      exsectionformat: 'wiki',
      lllimit: 'max',
      pithumbsize: '800',
      inprop: 'url',
      redirects: '1',
    }),
    { signal },
  );
  const page = details.query?.pages?.[0];
  if (!page || page.missing || !page.extract) return null;

  const { intro, sections } = splitSections(page.extract);
  const langlinks = page.langlinks ?? [];
  const englishTitle = lang === 'en' ? page.title : (langlinks.find((link) => link.lang === 'en')?.title ?? null);

  return {
    title: page.title,
    url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    lang,
    description: page.description ?? null,
    extract: paragraphs(intro).slice(0, 2).join('\n\n'),
    thumbnail: page.thumbnail?.source ?? null,
    languages: langlinks.length + 1,
    englishTitle,
    intro,
    sections,
    related: hits
      .slice(1)
      .map((hit) => hit.title)
      .filter((title) => !title.includes('(desambiguación)') && !title.includes('(disambiguation)'))
      .slice(0, 6),
  };
}

/** Finds the best Wikipedia article for a topic, trying the user's language first. */
export async function findWikipediaArticle(topic: string, lang: Lang, signal?: AbortSignal): Promise<WikiArticle | null> {
  const order: Lang[] = lang === 'es' ? ['es', 'en'] : ['en', 'es'];
  for (const candidate of order) {
    try {
      const article = await lookup(topic, candidate, signal);
      if (article) return article;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`Wikipedia lookup failed (${candidate}):`, (error as Error).message);
    }
  }
  return null;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Monthly pageviews for the last 24 complete months: a real-world "public interest" signal. */
export async function fetchPageviews(article: WikiArticle, signal?: AbortSignal): Promise<InterestData | null> {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 24, 1));
  const project = `${article.lang}.wikipedia.org`;
  const title = encodeURIComponent(article.title.replace(/ /g, '_'));

  const data = await fetchJson<PageviewsResponse>(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${project}/all-access/user/${title}/monthly/${yyyymmdd(start)}00/${yyyymmdd(end)}00`,
    { signal },
  );
  const points = (data.items ?? []).map((item) => ({
    period: `${item.timestamp.slice(0, 4)}-${item.timestamp.slice(4, 6)}`,
    views: item.views,
  }));
  if (points.length < 3) return null;

  const total = points.reduce((sum, point) => sum + point.views, 0);
  const lastSix = points.slice(-6).reduce((sum, point) => sum + point.views, 0);
  const previousSix = points.slice(-12, -6).reduce((sum, point) => sum + point.views, 0);

  return {
    article: article.title,
    project,
    points,
    total,
    avgMonthly: Math.round(total / points.length),
    trendPct: previousSix > 0 ? Math.round(((lastSix - previousSix) / previousSix) * 1000) / 10 : null,
  };
}
