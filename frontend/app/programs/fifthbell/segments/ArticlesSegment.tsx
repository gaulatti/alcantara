import { useEffect, useRef, useState } from 'react';
import { ArticleSlide, type NewsItem } from '../components/slides/ArticleSlide';
import type { Segment } from './types';
import { t, type SupportedLanguage } from '../i18n';

interface ApiArticle {
  id: number;
  title: string;
  excerpt: string;
  slug: string;
  url?: string | null;
  canonicalUrl?: string | null;
  featured: boolean;
  featuredImage: {
    url: string;
  };
  categories: {
    name: string;
    slug?: string | null;
  }[];
  publishedAt: string;
}

interface ApiResponse {
  articles: ApiArticle[];
}

const MOCK_ARTICLES: NewsItem[] = [
  {
    id: '1',
    headline: 'Global Climate Summit Reaches Historic Agreement',
    summary:
      'World leaders have agreed to ambitious new targets for reducing carbon emissions, marking a significant step forward in the fight against climate change.',
    imageUrl: 'https://picsum.photos/seed/news1/1920/1080',
    category: 'Environment',
    url: 'https://fifthbell.com/climate-summit-agreement'
  },
  {
    id: '2',
    headline: 'Breakthrough in Quantum Computing Announced',
    summary: 'Researchers have achieved a major milestone in quantum computing, potentially revolutionizing data processing and encryption technologies.',
    imageUrl: 'https://picsum.photos/seed/news2/1920/1080',
    category: 'Technology',
    url: 'https://fifthbell.com/quantum-computing-breakthrough'
  },
  {
    id: '3',
    headline: 'New Archaeological Discovery Rewrites Ancient History',
    summary: 'Archaeologists have unearthed artifacts that challenge our understanding of ancient civilizations and their technological capabilities.',
    imageUrl: 'https://picsum.photos/seed/news3/1920/1080',
    category: 'Science',
    url: 'https://fifthbell.com/archaeological-discovery'
  },
  {
    id: '4',
    headline: 'International Space Station Mission Extended',
    summary: 'NASA and international partners announce extension of ISS operations, paving the way for continued scientific research in orbit.',
    imageUrl: 'https://picsum.photos/seed/news4/1920/1080',
    category: 'Space',
    url: 'https://fifthbell.com/iss-mission-extended'
  },
  {
    id: '5',
    headline: 'Renewable Energy Surpasses Fossil Fuels',
    summary: 'For the first time in history, renewable energy sources have generated more electricity than traditional fossil fuels globally.',
    imageUrl: 'https://picsum.photos/seed/news5/1920/1080',
    category: 'Energy',
    url: 'https://fifthbell.com/renewable-energy-milestone'
  }
];

function normalizePath(input: string): string {
  if (!input) return '/';
  const stripped = input.split('?')[0] || '/';
  const normalized = `/${stripped.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
  return normalized !== '/' && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function asPathString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return normalizePath(trimmed);
}

function buildArticlePath(article: ApiArticle, language: SupportedLanguage): string {
  const explicitUrl = asPathString(article.url);
  const bareSlug = typeof article.slug === 'string' ? article.slug.trim() : '';
  const primaryCategorySlug = article.categories?.[0]?.slug?.trim();

  return (
    explicitUrl ||
    (primaryCategorySlug
      ? language === 'en'
        ? `/${primaryCategorySlug}/${bareSlug.replace(/^\//, '')}`
        : `/${language}/${primaryCategorySlug}/${bareSlug.replace(/^\//, '')}`
      : normalizePath(bareSlug || article.canonicalUrl || '/'))
  );
}

export async function fetchArticles(language: SupportedLanguage = 'en'): Promise<NewsItem[]> {
  try {
    const response = await fetch(`https://cdn.fifthbell.com/content/homepage-current-${language}.json?_=${Date.now()}`, {
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch homepage feed: ${response.status} ${response.statusText}`);
    }

    const data: ApiResponse = await response.json();
    const now = new Date();
    const recentThreshold = new Date(now.getTime() - 12 * 60 * 60 * 1000);
    const feedArticles = Array.isArray(data.articles) ? data.articles : [];

    const articlesWithImages = feedArticles
      .filter((article) => article.featuredImage?.url)
      .sort((a, b) => {
        const aFeatured = a.featured === true;
        const bFeatured = b.featured === true;
        if (aFeatured !== bFeatured) {
          return aFeatured ? -1 : 1;
        }
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      });

    const recentArticles = articlesWithImages.filter((article) => new Date(article.publishedAt) >= recentThreshold);
    const topRecentArticles = recentArticles.slice(0, 10);
    const selectedRecentIds = new Set(topRecentArticles.map((article) => article.id));
    const backfillArticles = articlesWithImages
      .filter((article) => !selectedRecentIds.has(article.id))
      .slice(0, Math.max(0, 10 - topRecentArticles.length));

    const selectedArticles = [...topRecentArticles, ...backfillArticles];

    const items: NewsItem[] = selectedArticles.map((article) => ({
      id: article.id.toString(),
      headline: article.title,
      summary: article.excerpt,
      imageUrl: article.featuredImage.url,
      category: article.categories?.[0]?.name,
      url: `https://fifthbell.com${buildArticlePath(article, language)}`
    }));

    const finalItems = items.length > 0 ? items : MOCK_ARTICLES;
    finalItems.forEach((item) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.src = item.imageUrl;
    });

    return finalItems;
  } catch (error) {
    console.error('Error fetching news items:', error);
    return MOCK_ARTICLES;
  }
}

interface ArticlesSegmentRendererProps {
  items: NewsItem[];
  itemIndex: number;
  progress: number;
  language: SupportedLanguage;
}

function ArticlesSegmentRenderer({ items, itemIndex, progress, language }: ArticlesSegmentRendererProps) {
  const [displayedIndex, setDisplayedIndex] = useState(itemIndex);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const previousIndexRef = useRef(itemIndex);

  useEffect(() => {
    if (itemIndex !== previousIndexRef.current && items.length > 0) {
      setIsTransitioning(true);
      const timer = window.setTimeout(() => {
        setDisplayedIndex(itemIndex);
        setIsTransitioning(false);
        previousIndexRef.current = itemIndex;
      }, 800);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [itemIndex, items.length]);

  if (items.length === 0) {
    return <div className='text-white'>{t('articles.noArticles', language)}</div>;
  }

  const currentItem = items[itemIndex % items.length];
  const previousItem = items[displayedIndex % items.length];

  return (
    <div className='relative w-full h-full'>
      {isTransitioning && previousItem && (
        <div className='absolute inset-0'>
          <ArticleSlide newsItem={previousItem} progress={100} />
        </div>
      )}
      <div className={`absolute inset-0 ${isTransitioning ? 'animate-slide-transition' : ''}`}>
        <ArticleSlide newsItem={currentItem} progress={progress} />
      </div>
    </div>
  );
}

export function createArticlesSegment(
  articles: NewsItem[],
  onDataUpdate?: (nextArticles: NewsItem[]) => void,
  language: SupportedLanguage = 'en'
): Segment {
  return {
    id: 'articles',
    label: t('segment.articles', language),
    get itemCount() {
      return articles.length > 0 ? articles.length : MOCK_ARTICLES.length;
    },
    durationMsPerItem: 10000,
    render: (itemIndex: number, progress: number) => {
      const items = articles.length > 0 ? articles : MOCK_ARTICLES;
      return (
        <ArticlesSegmentRenderer
          key={`article-${itemIndex}`}
          items={items}
          itemIndex={itemIndex}
          progress={progress}
          language={language}
        />
      );
    },
    prefetch: async () => {
      if (!onDataUpdate) {
        return;
      }
      const freshArticles = await fetchArticles(language);
      onDataUpdate(freshArticles);
    }
  };
}

export type { NewsItem };
