/**
 * Общие фикстуры для тестов текстов: профиль и задание в нужной форме.
 * Отдельный файл, чтобы не дублировать объекты между тестами.
 */

export function makeFixtureProfile(overrides = {}) {
  return {
    profile_version: 1,
    language: 'ru',
    headline: 'Фронтенд-разработчик — адаптивная вёрстка',
    skills: ['HTML', 'CSS', 'Адаптивная вёрстка', 'Figma'],
    portfolio: [
      {
        name: 'To-do — планировщик задач',
        repository_url: 'https://github.com/example/to-do',
        demo_url: 'https://example.github.io/to-do/',
        description: 'Одностраничное приложение на JavaScript.',
        stack: ['JavaScript', 'HTML', 'SCSS']
      }
    ],
    services: [{ name: 'Адаптивная вёрстка по макету', starting_price_rub: 2000, description: '—' }],
    excluded_work: ['Разработка backend и серверной бизнес-логики'],
    categories: { include: ['Вёрстка сайтов'], exclude: ['Backend-разработка'] },
    pricing: {
      currency: 'RUB',
      minimum_project_price: 2000,
      hourly_rate: 700,
      pricing_notes: '2 000 ₽ — стартовая цена.'
    },
    availability: {
      timezone: 'Asia/Ho_Chi_Minh',
      hours_per_week: 20,
      current_workload: null,
      earliest_start: null,
      preferred_deadline_days: 5
    },
    proposal_preferences: {
      tone: 'professional_friendly',
      preferred_length: 'concise',
      must_mention: ['Какие задачи входят в frontend-часть'],
      must_avoid: ['Фиксированная цена до уточнения объёма'],
      questions_before_quote: ['Есть ли готовые макеты в Figma или PSD?']
    },
    matching_preferences: {
      positive_keywords: ['Figma', 'адаптивная вёрстка', 'HTML', 'CSS', 'лендинг', 'макет'],
      negative_keywords: ['backend', 'full-stack', 'API-разработка', 'SaaS'],
      minimum_budget_override: null
    },
    ...overrides
  };
}

export function makeFixtureJob(overrides = {}) {
  return {
    id: '5001',
    url: 'https://kwork.ru/projects/5001/verstka-lendinga-po-maketu-figma',
    title: 'Вёрстка лендинга по макету Figma',
    description: 'Нужно сверстать одностраничный лендинг по готовому макету Figma с адаптивом.',
    descriptionSource: 'embedded-json',
    budget: { min: 5000, max: 5000, currency: 'RUB', text: '5 000 ₽', isRange: false, isFrom: false },
    publishedAt: {
      text: '10 минут назад',
      iso: '2026-10-07T09:50:00.000Z',
      origin: 'derived:relative',
      confidence: 'derived'
    },
    category: {
      id: 'markup-by-layout',
      label: 'Вёрстка - Верстка по макету',
      matchedBy: 'kwork-category-id',
      confidence: 'high',
      declared: 'Вёрстка'
    },
    declaredCategory: 'Вёрстка',
    kworkCategoryId: 37,
    categoryLinkIds: [37],
    client: { name: 'client_one', meta: 'https://kwork.ru/user/client_one' },
    extra: { status: 'active', offersCount: 3, kworkCount: 1, views: 40, maxDays: 10, timeLeft: '2 д.' },
    offersCount: 3,
    cardText: 'Вёрстка лендинга по макету Figma',
    dedupKey: 'id:5001',
    dedupKind: 'stable-id',
    missingFields: [],
    warnings: [],
    provenance: {
      sourceUrl: 'https://kwork.ru/projects?c=37',
      strategy: 'embedded-json:wants',
      extractedAt: '2026-10-07T10:00:00.000Z',
      rawHtmlStored: false
    },
    ...overrides
  };
}
