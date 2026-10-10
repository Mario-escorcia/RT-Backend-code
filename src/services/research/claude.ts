import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { domainOf } from '../../lib/text.js';
import { assessSource } from './credibility.js';
import {
  CATEGORIES,
  CHART_TYPES,
  ResearchError,
  SOURCE_TYPES,
  type ChartSpec,
  type Lang,
  type ProgressFn,
  type Report,
  type Source,
} from './types.js';

const MAX_SOURCES = 15;
const MAX_CONTINUATIONS = 3;
// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const BLOCKED_DOMAINS = [
  'pinterest.com', 'quora.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com',
  'linkedin.com', 'youtube.com', 'reddit.com',
];

const LANGUAGE_NAME: Record<Lang, string> = { es: 'Spanish', en: 'English' };

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic();
  return client;
}

function fallbackOptions() {
  return FALLBACK_MODELS.has(env.ANTHROPIC_MODEL)
    ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
    : {};
}

// ---------------------------------------------------------------------------
// Step 1: web research with the server-side web search tool
// ---------------------------------------------------------------------------

function researchSystem(lang: Lang): string {
  return `You are the research engine of a personal knowledge dashboard. Investigate the user's topic on the web and write dense, well-sourced research notes that a second step will turn into an executive briefing with charts.

Source quality matters more than volume. Favour primary and authoritative sources: government and statistical agencies, international organisations, peer-reviewed research, universities and established newsrooms. Avoid content farms, social media, forums and SEO listicles. When sources disagree, record who says what.

Charts are built only from numbers you report, so look for quantitative data: time series, rankings, shares and percentages, comparisons between countries, groups or products, market sizes and growth rates. For every figure record its unit, the year or period it refers to, and its source. Never estimate or invent a number; if the topic has little quantitative data, say so plainly and focus on the strongest qualitative findings.

Write the notes in ${LANGUAGE_NAME[lang]}, organised as: overview; key facts; quantitative data (one datum per line with unit, period and source); timeline of important dates; areas of consensus; open debates or uncertainties; related topics worth exploring.`;
}

interface CollectedSource {
  url: string;
  title: string;
  pageAge: string | null;
  snippets: string[];
  cited: boolean;
  order: number;
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

async function runWebResearch(topic: string, lang: Lang, onProgress: ProgressFn, signal: AbortSignal) {
  const anthropic = getClient();
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: `Topic: ${topic}\nToday's date: ${new Date().toISOString().slice(0, 10)}\n\nResearch this topic now.`,
    },
  ];
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const queries: string[] = [];
  let searchCount = 0;

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const stream = anthropic.beta.messages.stream(
      {
        model: env.ANTHROPIC_MODEL,
        max_tokens: 32_000,
        ...fallbackOptions(),
        output_config: { effort: env.RESEARCH_EFFORT },
        system: researchSystem(lang),
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: env.WEB_SEARCH_MAX_USES,
            blocked_domains: BLOCKED_DOMAINS,
          },
        ],
        messages,
      },
      { signal },
    );

    stream.on('contentBlock', (block) => {
      if (block.type === 'server_tool_use' && block.name === 'web_search') {
        const query = typeof block.input['query'] === 'string' ? block.input['query'] : '';
        if (query) queries.push(query);
        searchCount++;
        onProgress({ stage: 'searching', percent: Math.min(15 + searchCount * 8, 55), query });
      } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        onProgress({
          stage: 'sources',
          percent: Math.min(18 + searchCount * 8, 58),
          sources: block.content.slice(0, 6).map((result) => ({
            title: result.title,
            url: result.url,
            domain: domainOf(result.url),
          })),
        });
      }
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      throw new ResearchError('refused', message.stop_details?.explanation ?? 'The model declined this topic.');
    }
    content.push(...message.content);
    if (message.stop_reason !== 'pause_turn') break;
    // Long server-tool turns pause; resend the conversation so the model can continue.
    messages.push({ role: 'assistant', content: message.content });
  }

  return { content, queries };
}

/** Numbers the collected web sources (cited first) and renders the notes with [n] markers. */
function buildNotes(content: Anthropic.Beta.BetaContentBlock[]) {
  const collected = new Map<string, CollectedSource>();
  let order = 0;
  const upsert = (url: string, title: string | null, pageAge: string | null) => {
    const key = canonicalUrl(url);
    const existing = collected.get(key);
    if (existing) return existing;
    const created: CollectedSource = { url, title: title || domainOf(url), pageAge, snippets: [], cited: false, order: order++ };
    collected.set(key, created);
    return created;
  };

  for (const block of content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) upsert(result.url, result.title, result.page_age);
    }
    if (block.type === 'text') {
      for (const citation of block.citations ?? []) {
        if (citation.type !== 'web_search_result_location') continue;
        const source = upsert(citation.url, citation.title, null);
        source.cited = true;
        if (citation.cited_text && source.snippets.length < 3) source.snippets.push(citation.cited_text);
      }
    }
  }

  const ranked = [...collected.values()]
    .sort((a, b) => Number(b.cited) - Number(a.cited) || a.order - b.order)
    .slice(0, MAX_SOURCES);
  const idOf = new Map(ranked.map((source, index) => [canonicalUrl(source.url), index + 1]));

  let notes = '';
  for (const block of content) {
    if (block.type !== 'text') continue;
    notes += block.text;
    const ids = new Set<number>();
    for (const citation of block.citations ?? []) {
      if (citation.type !== 'web_search_result_location') continue;
      const id = idOf.get(canonicalUrl(citation.url));
      if (id) ids.add(id);
    }
    if (ids.size) notes += ` [${[...ids].join(', ')}]`;
  }

  return { notes: notes.trim(), sources: ranked };
}

// ---------------------------------------------------------------------------
// Step 2: turn the notes into a structured, chart-ready briefing
// ---------------------------------------------------------------------------

const ReportSchema = z.object({
  title: z.string(),
  category: z.enum(CATEGORIES),
  tldr: z.string(),
  summary: z.string(),
  keyPoints: z.array(z.object({ title: z.string(), detail: z.string(), sourceIds: z.array(z.number()) })),
  metrics: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      numericValue: z.number().nullable(),
      unit: z.string().nullable(),
      context: z.string(),
      trend: z.enum(['up', 'down', 'neutral']).nullable(),
      sourceId: z.number().nullable(),
    }),
  ),
  charts: z.array(
    z.object({
      type: z.enum(CHART_TYPES),
      title: z.string(),
      description: z.string(),
      unit: z.string().nullable(),
      labels: z.array(z.string()),
      series: z.array(z.object({ name: z.string(), data: z.array(z.number().nullable()) })),
      sourceIds: z.array(z.number()),
    }),
  ),
  timeline: z.array(z.object({ date: z.string(), title: z.string(), description: z.string() })),
  sections: z.array(z.object({ heading: z.string(), body: z.string() })),
  perspectives: z.object({ consensus: z.array(z.string()), debates: z.array(z.string()) }),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })),
  relatedTopics: z.array(z.string()),
  confidence: z.object({ level: z.enum(['high', 'medium', 'low']), rationale: z.string() }),
  sourceAssessments: z.array(z.object({ id: z.number(), publisher: z.string(), type: z.enum(SOURCE_TYPES) })),
});

function structureSystem(lang: Lang): string {
  return `You turn research notes into a structured briefing for a reader who loves data and analysis. Follow the JSON schema and write every human-readable string in ${LANGUAGE_NAME[lang]}.

Grounding: every number in metrics and charts must come from the research notes, and sourceIds must point to the numbered sources that support it. Do not create, extrapolate or estimate numbers; leave a chart out rather than invent data.

- tldr: one sentence. summary: an executive summary of 3-5 sentences.
- keyPoints: 4-6 insights, each a short title plus a 1-2 sentence detail.
- metrics: 3-6 headline figures for KPI cards. value is formatted for display (e.g. "4.2 M", "37 %", "USD 1.3 T"); numericValue is the raw number when there is one.
- charts: up to 4 charts, only where the notes have comparable data points (ideally 3 or more per chart). Pick the type that fits: line or area for time series, bar for category comparisons, horizontalBar for rankings with long labels, pie or doughnut only for parts of a whole, radar for multi-attribute comparisons. Each series' data must align one-to-one with labels (null for a missing point). Keep one unit per chart and state it.
- timeline: dated milestones in chronological order (can be empty).
- sections: 2-4 deeper sections of 1-2 short plain-text paragraphs each.
- perspectives: points of broad consensus, and open debates or uncertainties.
- faq: 3-4 questions a curious reader would ask next, with concise answers.
- relatedTopics: 4-6 short follow-up topics.
- confidence: how well the sources support the briefing, with a one-sentence rationale.
- sourceAssessments: for each numbered source, its publisher name and type.`;
}

function sanitizeCharts(charts: z.infer<typeof ReportSchema>['charts'], validIds: Set<number>): ChartSpec[] {
  const result: ChartSpec[] = [];
  charts.forEach((chart) => {
    const labels = chart.labels.slice(0, 30);
    const series = chart.series
      .map((serie) => ({
        name: serie.name,
        data: labels.map((_, index) => {
          const value = serie.data[index];
          return typeof value === 'number' && Number.isFinite(value) ? value : null;
        }),
      }))
      .filter((serie) => serie.data.filter((value) => value !== null).length >= 2)
      .slice(0, 5);
    if (labels.length < 2 || !series.length) return;

    let type = chart.type;
    if ((type === 'pie' || type === 'doughnut') && series.length > 1) type = 'bar';
    if (type === 'radar' && labels.length < 3) type = 'bar';

    result.push({
      id: `chart-${result.length + 1}`,
      type,
      title: chart.title,
      description: chart.description,
      unit: chart.unit,
      labels,
      series,
      sourceIds: chart.sourceIds.filter((id) => validIds.has(id)),
    });
  });
  return result.slice(0, 4);
}

export interface ClaudeResearchOutput {
  report: Report;
  sources: Source[];
  queries: string[];
  model: string;
}

export async function researchWithClaude(
  topic: string,
  lang: Lang,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<ClaudeResearchOutput> {
  onProgress({ stage: 'searching', percent: 8 });
  const { content, queries } = await runWebResearch(topic, lang, onProgress, signal);
  const { notes, sources: collected } = buildNotes(content);
  if (!notes) throw new ResearchError('provider_error', 'The research step returned no notes.');

  onProgress({ stage: 'analyzing', percent: 64 });
  const sourceList = collected
    .map((source, index) => `[${index + 1}] ${source.title} — ${source.url}${source.pageAge ? ` (${source.pageAge})` : ''}`)
    .join('\n');

  onProgress({ stage: 'structuring', percent: 72 });
  const response = await getClient().beta.messages.parse(
    {
      model: env.ANTHROPIC_MODEL,
      max_tokens: 16_000,
      ...fallbackOptions(),
      output_config: { effort: env.RESEARCH_EFFORT, format: betaZodOutputFormat(ReportSchema) },
      system: structureSystem(lang),
      messages: [
        {
          role: 'user',
          content: `Topic: ${topic}\n\n<numbered_sources>\n${sourceList}\n</numbered_sources>\n\n<research_notes>\n${notes}\n</research_notes>`,
        },
      ],
    },
    { signal },
  );
  if (response.stop_reason === 'refusal') {
    throw new ResearchError('refused', response.stop_details?.explanation ?? 'The model declined this topic.');
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new ResearchError('provider_error', `Structured output missing (stop_reason: ${response.stop_reason}).`);

  const assessments = new Map(parsed.sourceAssessments.map((assessment) => [assessment.id, assessment]));
  const sources: Source[] = collected.map((source, index) => {
    const id = index + 1;
    const hint = assessments.get(id);
    const assessed = assessSource(source.url, hint?.type);
    return {
      id,
      title: source.title,
      url: source.url,
      domain: assessed.domain,
      publisher: hint?.publisher || assessed.domain,
      publishedAt: source.pageAge,
      type: assessed.type,
      credibility: assessed.credibility,
      snippet: source.snippets[0] ?? null,
      cited: source.cited,
    };
  });
  const validIds = new Set(sources.map((source) => source.id));
  const validId = (id: number | null) => (id !== null && validIds.has(id) ? id : null);

  const { sourceAssessments: _unused, charts, ...rest } = parsed;
  const report: Report = {
    ...rest,
    keyPoints: rest.keyPoints.map((point) => ({ ...point, sourceIds: point.sourceIds.filter((id) => validIds.has(id)) })),
    metrics: rest.metrics.slice(0, 6).map((metric) => ({ ...metric, sourceId: validId(metric.sourceId) })),
    charts: sanitizeCharts(charts, validIds),
  };

  return { report, sources, queries, model: response.model };
}
