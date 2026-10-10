export type Lang = 'es' | 'en';

export const CATEGORIES = [
  'technology',
  'science',
  'health',
  'economy',
  'business',
  'politics',
  'history',
  'society',
  'culture',
  'education',
  'environment',
  'sports',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SOURCE_TYPES = [
  'academic',
  'government',
  'international',
  'news',
  'reference',
  'organization',
  'industry',
  'other',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const CHART_TYPES = ['bar', 'horizontalBar', 'line', 'area', 'pie', 'doughnut', 'radar'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface ChartSpec {
  id: string;
  type: ChartType;
  title: string;
  description: string;
  unit: string | null;
  labels: string[];
  series: { name: string; data: (number | null)[] }[];
  sourceIds: number[];
}

export interface Metric {
  label: string;
  value: string;
  numericValue: number | null;
  unit: string | null;
  context: string;
  trend: 'up' | 'down' | 'neutral' | null;
  sourceId: number | null;
}

export interface Report {
  title: string;
  category: Category;
  tldr: string;
  summary: string;
  keyPoints: { title: string; detail: string; sourceIds: number[] }[];
  metrics: Metric[];
  charts: ChartSpec[];
  timeline: { date: string; title: string; description: string }[];
  sections: { heading: string; body: string }[];
  perspectives: { consensus: string[]; debates: string[] };
  faq: { question: string; answer: string }[];
  relatedTopics: string[];
  confidence: { level: 'high' | 'medium' | 'low'; rationale: string };
}

export interface Source {
  id: number;
  title: string;
  url: string;
  domain: string;
  publisher: string;
  publishedAt: string | null;
  type: SourceType;
  credibility: number;
  snippet: string | null;
  cited: boolean;
}

export interface WikipediaInfo {
  title: string;
  url: string;
  lang: Lang;
  description: string | null;
  extract: string;
  thumbnail: string | null;
  languages: number;
  englishTitle: string | null;
}

export interface InterestData {
  article: string;
  project: string;
  points: { period: string; views: number }[];
  total: number;
  avgMonthly: number;
  trendPct: number | null;
}

export interface AcademicData {
  query: string;
  total: number;
  byYear: { year: number; count: number }[];
  growthPct: number | null;
  countries: { code: string; name: string; count: number }[];
  fields: { name: string; count: number }[];
  topWorks: { title: string; year: number | null; citations: number; url: string | null; venue: string | null }[];
}

export interface Enrichment {
  wikipedia: WikipediaInfo | null;
  interest: InterestData | null;
  academic: AcademicData | null;
  related: string[];
}

export interface ResearchMeta {
  provider: 'claude' | 'open-data';
  model: string | null;
  researchMs: number;
  searchQueries: string[];
  sourceCount: number;
  warnings: string[];
  generatedAt: string;
}

export interface ResearchResult {
  topic: string;
  language: Lang;
  report: Report;
  sources: Source[];
  enrichment: Enrichment;
  meta: ResearchMeta;
}

export type ProgressStage = 'start' | 'searching' | 'sources' | 'enriching' | 'analyzing' | 'structuring' | 'finalizing';

export interface ProgressEvent {
  stage: ProgressStage;
  percent: number;
  query?: string;
  sources?: { title: string; url: string; domain: string }[];
}

export type ProgressFn = (event: ProgressEvent) => void;

export class ResearchError extends Error {
  constructor(
    readonly code: 'not_found' | 'refused' | 'provider_error',
    message: string,
  ) {
    super(message);
  }
}
