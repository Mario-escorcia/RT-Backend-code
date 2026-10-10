import { env, researchProvider } from '../../config/env.js';
import { assessSource } from './credibility.js';
import { researchWithClaude, type ClaudeResearchOutput } from './claude.js';
import { fetchAcademic } from './openalex.js';
import { buildOpenDataReport } from './openData.js';
import { ResearchError, type Lang, type ProgressFn, type ResearchResult, type Source } from './types.js';
import { fetchPageviews, findWikipediaArticle } from './wikipedia.js';

export { ResearchError } from './types.js';
export type { ResearchResult, ProgressEvent } from './types.js';

const DATA_SOURCE_COPY = {
  es: { pageviews: 'Estadísticas de páginas vistas de Wikimedia', openalex: 'OpenAlex — índice abierto de literatura académica' },
  en: { pageviews: 'Wikimedia pageview statistics', openalex: 'OpenAlex — open index of scholarly literature' },
};

/** Wikipedia + pageviews + OpenAlex: real, verifiable data available for almost any topic. */
async function gatherOpenData(topic: string, lang: Lang, signal: AbortSignal, onProgress: ProgressFn) {
  onProgress({ stage: 'enriching', percent: 10 });
  const article = await findWikipediaArticle(topic, lang, signal);
  const academicQuery = article?.englishTitle ?? (article?.lang === 'en' ? article.title : topic);

  const [interest, academic] = await Promise.all([
    article
      ? fetchPageviews(article, signal).catch((error: Error) => {
          console.warn('Pageviews failed:', error.message);
          return null;
        })
      : null,
    fetchAcademic(academicQuery, signal).catch((error: Error) => {
      console.warn('OpenAlex failed:', error.message);
      return null;
    }),
  ]);
  return { article, interest, academic };
}

function dataSources(
  lang: Lang,
  startId: number,
  data: Awaited<ReturnType<typeof gatherOpenData>>,
): { sources: Source[]; ids: { wikipedia: number | null; pageviews: number | null; openalex: number | null } } {
  const sources: Source[] = [];
  const ids = { wikipedia: null as number | null, pageviews: null as number | null, openalex: null as number | null };
  const add = (source: Omit<Source, 'id' | 'domain' | 'type' | 'credibility'>, key: keyof typeof ids) => {
    const assessed = assessSource(source.url);
    const id = startId + sources.length;
    sources.push({ id, ...source, ...assessed });
    ids[key] = id;
  };

  if (data.article) {
    add(
      { title: data.article.title, url: data.article.url, publisher: 'Wikipedia', publishedAt: null, snippet: data.article.description, cited: true },
      'wikipedia',
    );
  }
  if (data.interest) {
    add(
      {
        title: DATA_SOURCE_COPY[lang].pageviews,
        url: `https://pageviews.wmcloud.org/?project=${data.interest.project}&pages=${encodeURIComponent(data.interest.article.replace(/ /g, '_'))}&range=latest-730`,
        publisher: 'Wikimedia Foundation',
        publishedAt: null,
        snippet: null,
        cited: true,
      },
      'pageviews',
    );
  }
  if (data.academic) {
    add(
      {
        title: DATA_SOURCE_COPY[lang].openalex,
        url: `https://openalex.org/works?search=${encodeURIComponent(data.academic.query)}`,
        publisher: 'OpenAlex (OurResearch)',
        publishedAt: null,
        snippet: null,
        cited: true,
      },
      'openalex',
    );
    for (const work of data.academic.topWorks.slice(0, 3)) {
      if (!work.url) continue;
      const id = startId + sources.length;
      sources.push({
        id,
        title: work.title,
        url: work.url,
        domain: 'doi.org',
        publisher: work.venue ?? 'OpenAlex',
        publishedAt: work.year ? String(work.year) : null,
        type: 'academic',
        credibility: 90,
        snippet: null,
        cited: false,
      });
    }
  }
  return { sources, ids };
}

export interface RunResearchOptions {
  topic: string;
  lang: Lang;
  signal: AbortSignal;
  onProgress: ProgressFn;
}

export async function runResearch({ topic, lang, signal, onProgress }: RunResearchOptions): Promise<ResearchResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  onProgress({ stage: 'start', percent: 3 });

  const openDataPromise = gatherOpenData(topic, lang, signal, onProgress);

  let claude: ClaudeResearchOutput | null = null;
  if (researchProvider === 'claude') {
    try {
      claude = await researchWithClaude(topic, lang, onProgress, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      console.error('Claude research failed, falling back to open data:', error);
      warnings.push(error instanceof ResearchError && error.code === 'refused' ? 'claude_refused' : 'claude_unavailable');
    }
  }

  const openData = await openDataPromise;
  if (signal.aborted) throw new Error('aborted');
  onProgress({ stage: 'finalizing', percent: 92 });

  const webSources = claude?.sources ?? [];
  const extra = dataSources(lang, webSources.length + 1, openData);
  const report = claude?.report ?? buildOpenDataReport(topic, lang, openData, extra.ids);

  if (!claude && !openData.article && !openData.academic) {
    throw new ResearchError('not_found', 'No reliable information was found for this topic.');
  }

  const sources = [...webSources, ...extra.sources];
  return {
    topic,
    language: lang,
    report,
    sources,
    enrichment: {
      wikipedia: openData.article
        ? {
            title: openData.article.title,
            url: openData.article.url,
            lang: openData.article.lang,
            description: openData.article.description,
            extract: openData.article.extract,
            thumbnail: openData.article.thumbnail,
            languages: openData.article.languages,
            englishTitle: openData.article.englishTitle,
          }
        : null,
      interest: openData.interest,
      academic: openData.academic,
      related: openData.article?.related ?? [],
    },
    meta: {
      provider: claude ? 'claude' : 'open-data',
      model: claude?.model ?? (claude ? env.ANTHROPIC_MODEL : null),
      researchMs: Date.now() - startedAt,
      searchQueries: claude?.queries ?? [],
      sourceCount: sources.length,
      warnings,
      generatedAt: new Date().toISOString(),
    },
  };
}
