import { compactNumber, firstSentences, paragraphs, splitSentences, truncate } from '../../lib/text.js';
import { categoryFromFields } from './openalex.js';
import type { AcademicData, InterestData, Lang, Metric, Report } from './types.js';
import type { WikiArticle } from './wikipedia.js';

const COPY = {
  es: {
    avgViews: 'Vistas mensuales promedio',
    avgViewsContext: 'Lectores de Wikipedia, últimos 24 meses',
    languages: 'Idiomas con artículo',
    languagesContext: 'Alcance global del tema en Wikipedia',
    publications: 'Publicaciones académicas',
    publicationsContext: 'Trabajos indexados en OpenAlex',
    growth: 'Crecimiento académico (5 años)',
    growthContext: 'Variación de publicaciones anuales',
    leadingCountry: 'País líder en investigación',
    leadingCountryContext: (count: string) => `${count} publicaciones en 15 años`,
    topCited: 'Citas del trabajo más citado',
    confidenceWiki: 'Basado en Wikipedia y datos abiertos (Wikimedia, OpenAlex). Sin síntesis de IA: activa Claude para análisis web completo.',
    confidenceAcademic: 'Basado solo en metadatos académicos de OpenAlex; no se encontró artículo enciclopédico.',
  },
  en: {
    avgViews: 'Average monthly views',
    avgViewsContext: 'Wikipedia readers, last 24 months',
    languages: 'Languages with an article',
    languagesContext: 'Global reach of the topic on Wikipedia',
    publications: 'Academic publications',
    publicationsContext: 'Works indexed in OpenAlex',
    growth: 'Academic growth (5 years)',
    growthContext: 'Change in yearly publications',
    leadingCountry: 'Leading research country',
    leadingCountryContext: (count: string) => `${count} publications in 15 years`,
    topCited: 'Citations of the most cited work',
    confidenceWiki: 'Based on Wikipedia and open data (Wikimedia, OpenAlex). No AI synthesis: enable Claude for full web analysis.',
    confidenceAcademic: 'Based only on OpenAlex scholarly metadata; no encyclopedic article was found.',
  },
} as const;

const HISTORY_HEADING = /histor|origen|orígenes|origin|background|antecedentes|cronolog|timeline|evoluci|development|desarrollo/i;
const YEAR_PATTERN = /\b(1[0-9]{3}|20[0-9]{2})\b/;

function extractTimeline(article: WikiArticle): Report['timeline'] {
  // History-like sections first, then the rest of the article.
  const ordered = [
    ...article.sections.filter((section) => HISTORY_HEADING.test(section.heading)),
    ...article.sections.filter((section) => !HISTORY_HEADING.test(section.heading)),
  ];
  const pool = [article.intro, ...ordered.map((section) => section.text)].join(' ');
  const seen = new Set<string>();
  const items: Report['timeline'] = [];

  for (const sentence of splitSentences(pool)) {
    if (items.length >= 8) break;
    const match = YEAR_PATTERN.exec(sentence);
    if (!match || sentence.length < 40 || sentence.length > 320 || seen.has(match[1])) continue;
    seen.add(match[1]);
    // Sentences extracted heuristically have no reliable headline; the date + sentence carry it.
    items.push({ date: match[1], title: '', description: sentence });
  }
  return items.sort((a, b) => Number(a.date) - Number(b.date));
}

function countryName(code: string, fallback: string, lang: Lang): string {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? fallback;
  } catch {
    return fallback;
  }
}

function signedPercent(value: number, lang: Lang): string {
  const formatted = new Intl.NumberFormat(lang === 'es' ? 'es-ES' : 'en-US', { maximumFractionDigits: 1 }).format(value);
  return `${value > 0 ? '+' : ''}${formatted}%`;
}

/** Builds a briefing from open data only (no LLM). Used without Claude credentials or as a fallback. */
export function buildOpenDataReport(
  topic: string,
  lang: Lang,
  data: { article: WikiArticle | null; interest: InterestData | null; academic: AcademicData | null },
  sourceIds: { wikipedia: number | null; pageviews: number | null; openalex: number | null },
): Report {
  const copy = COPY[lang];
  const { article, interest, academic } = data;
  const metrics: Metric[] = [];

  if (interest) {
    metrics.push({
      label: copy.avgViews,
      value: compactNumber(interest.avgMonthly, lang),
      numericValue: interest.avgMonthly,
      unit: null,
      context: copy.avgViewsContext,
      trend: interest.trendPct === null ? null : interest.trendPct > 2 ? 'up' : interest.trendPct < -2 ? 'down' : 'neutral',
      sourceId: sourceIds.pageviews,
    });
  }
  if (article && article.languages > 1) {
    metrics.push({
      label: copy.languages,
      value: String(article.languages),
      numericValue: article.languages,
      unit: null,
      context: copy.languagesContext,
      trend: null,
      sourceId: sourceIds.wikipedia,
    });
  }
  if (academic) {
    metrics.push({
      label: copy.publications,
      value: compactNumber(academic.total, lang),
      numericValue: academic.total,
      unit: null,
      context: copy.publicationsContext,
      trend: null,
      sourceId: sourceIds.openalex,
    });
    if (academic.growthPct !== null) {
      metrics.push({
        label: copy.growth,
        value: signedPercent(academic.growthPct, lang),
        numericValue: academic.growthPct,
        unit: '%',
        context: copy.growthContext,
        trend: academic.growthPct > 2 ? 'up' : academic.growthPct < -2 ? 'down' : 'neutral',
        sourceId: sourceIds.openalex,
      });
    }
    const leader = academic.countries[0];
    if (leader) {
      metrics.push({
        label: copy.leadingCountry,
        value: countryName(leader.code, leader.name, lang),
        numericValue: null,
        unit: null,
        context: copy.leadingCountryContext(compactNumber(leader.count, lang)),
        trend: null,
        sourceId: sourceIds.openalex,
      });
    }
    const topWork = academic.topWorks[0];
    if (topWork && metrics.length < 6) {
      metrics.push({
        label: copy.topCited,
        value: compactNumber(topWork.citations, lang),
        numericValue: topWork.citations,
        unit: null,
        context: truncate(topWork.title, 80),
        trend: null,
        sourceId: sourceIds.openalex,
      });
    }
  }

  const introParagraphs = article ? paragraphs(article.intro) : [];
  const summary = article
    ? truncate(introParagraphs.slice(0, 2).join(' '), 900)
    : (academic?.topWorks.map((work) => work.title).join(' · ') ?? topic);
  const tldr = article?.description
    ? `${article.title}: ${article.description}.`
    : firstSentences(summary, 1, 240);

  return {
    title: article?.title ?? topic,
    category: academic ? categoryFromFields(academic.fields) : 'other',
    tldr,
    summary,
    keyPoints: (article?.sections ?? []).slice(0, 5).map((section) => ({
      title: section.heading,
      detail: firstSentences(section.text, 2, 320),
      sourceIds: sourceIds.wikipedia ? [sourceIds.wikipedia] : [],
    })),
    metrics: metrics.slice(0, 6),
    charts: [],
    timeline: article ? extractTimeline(article) : [],
    sections: (article?.sections ?? []).slice(0, 6).map((section) => ({
      heading: section.heading,
      body: truncate(paragraphs(section.text).slice(0, 2).join('\n\n'), 1200),
    })),
    perspectives: { consensus: [], debates: [] },
    faq: [],
    relatedTopics: article?.related ?? [],
    confidence: {
      level: article ? 'medium' : 'low',
      rationale: article ? copy.confidenceWiki : copy.confidenceAcademic,
    },
  };
}
