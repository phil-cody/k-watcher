# База знаний: Kwork watcher bot

Документ для самостоятельного изучения и модификации проекта. Описывает, **как всё устроено,
почему именно так и что нельзя ломать**. Все примеры — реальные выдержки из кода и данных проекта.

- [0. Быстрый вход](#0-быстрый-вход)
- [1. Карта проекта](#1-карта-проекта)
- [2. Сквозной поток данных](#2-сквозной-поток-данных)
- [3. Слой за слоем](#3-слой-за-слоем)
- [4. Инварианты, которые нельзя ломать](#4-инварианты-которые-нельзя-ломать)
- [5. Справочники: перечисления, формы данных, лимиты](#5-справочники-перечисления-формы-данных-лимиты)
- [6. Файлы состояния и форматы](#6-файлы-состояния-и-форматы)
- [7. CLI: режимы, побочные эффекты, коды возврата](#7-cli-режимы-побочные-эффекты-коды-возврата)
- [8. Как расширять: типовые задачи](#8-как-расширять-типовые-задачи)
- [9. Диагностика: что делать, если…](#9-диагностика-что-делать-если)
- [10. Тесты](#10-тесты)
- [11. Инструменты разработчика](#11-инструменты-разработчика)
- [12. Тексты интерфейса](#12-тексты-интерфейса)
- [12a. Уведомления о границах окна](#12a-уведомления-о-границах-окна)
- [12b. Оценка цены и срока](#12b-оценка-цены-и-срока)
- [12c. Черновик отклика](#12c-черновик-отклика)
- [13. Безопасность и приватность](#13-безопасность-и-приватность)
- [14. Перенос на VPS](#14-перенос-на-vps)
- [15. Рецепты модификаций](#15-рецепты-модификаций)
- [16. Границы проекта](#16-границы-проекта)
- [18. Подключение бота и доступ пользователей](#18-подключение-бота-и-доступ-пользователей)
- [18a. Профиль у каждого пользователя](#18a-профиль-у-каждого-пользователя)
- [18b. Категории у каждого пользователя](#18b-категории-у-каждого-пользователя)
- [18c. Защита загружаемого файла](#18c-защита-загружаемого-файла)
- [18d. Использование приложения (/usage)](#18d-использование-приложения-usage)
- [19. Модель анализа](#19-модель-анализа)
- [20. Глоссарий](#20-глоссарий)

---

## 0. Быстрый вход

**Что делает проект.** Личный Telegram-бот: раз в 4–10 минут забирает HTML страниц списка
заданий Kwork, вытаскивает новые задания в выбранных категориях, оценивает их относительно
профиля исполнителя и присылает владельцу сообщение с оценкой и черновиком отклика.
Никаких действий на Kwork бот не выполняет.

**Минимальный сценарий «увидеть, как работает»:**

```bash
node --test                  # 146 тестов, сеть не нужна
node src/index.js dry-run    # разбор сохранённых fixtures, сообщения в stdout
```

**Сценарий «изменить поведение»:**

```bash
node src/index.js plan          # что именно бот будет запрашивать
# правите config/default.json
node src/index.js config-check  # проверка без запросов
node --test                     # тесты
```

**Ключевая мысль архитектуры.** Весь проект — это **конвейер из чистых-ish функций,
разделённых по слоям, где каждый слой можно подменить в тестах**: источник HTML, парсер,
хранилище, анализатор, отправитель, планировщик. Связывает их `src/index.js` (композиция)
и `src/scheduler/cycle.js` (один цикл опроса).

---

## 1. Карта проекта

```
src/
  index.js                         443  точка входа: CLI, композиция зависимостей (bootstrap)
  config/load-config.js            360  чтение/валидация конфига и профиля, границы разрешённых URL
  util/html.js                     277  свой токенизатор HTML и дерево узлов
  util/time.js                     265  часовые пояса, окно опроса, случайный интервал
  util/logger.js                    74  логирование с редактированием секретов
  source/kwork-html-source.js      199  HTTP-источник: один GET, таймауты, стоп при защите
  parser/embedded-json-parser.js   329  ГЛАВНЫЙ парсер: JSON внутри HTML (массив wants)
  parser/job-parser.js             442  оркестрация стратегий парсинга, форма задания
  parser/anomaly-detector.js       193  детектор реальной проверки/блокировки
  parser/structure-detector.js     218  DOM-стратегии (запасной путь) + JSON-LD
  parser/normalize.js              254  нормализация полей: бюджет, даты, id, категории
  storage/job-store.js             359  индекс дедупликации, журнал, очистка, состояние
  analysis/analyzer.js             442  эвристика: соответствие профилю, риски, вердикт
  analysis/rate-estimator.js       ~   оценка цены и срока от ставки профиля
  analysis/model-usage.js          ~   учёт расхода квоты модели (сутки/час)
  storage/profile-store.js         ~   профили на пользователя: загрузка, проверка, напоминания
  storage/profile-guard.js         ~   защита загружаемого профиля: схема, лимиты, прототипы
  storage/category-store.js        ~   персональные категории заданий и каталог
  storage/category-catalog.js      ~   каталог сайта: разбор страницы, поиск по названию
  source/poll-plan.js              ~   план опроса: URL по выбранным категориям
  analysis/job-signals.js          ~   что реально есть в тексте задания (ссылки, вложения, элементы)
  analysis/proposal-draft.js       ~   черновик отклика в стиле пользователя
  analysis/compose-analysis.js      51  склейка: анализ + модель + черновик
  analysis/model-adapter.js        158  адаптер LLM (по умолчанию выключен)
  telegram/format.js               226  HTML-сообщение из блоков
  telegram/client.js               130  тонкий клиент Bot API
  telegram/state.js                 51  chat id и offset в файле
  scheduler/scheduler.js           321  окно, пауза, политика остановки
  scheduler/cycle.js               374  один цикл: запросы → разбор → отправка → очистка
  bot/kwork-watcher-bot.js         323  команды /status /pause /resume, оркестрация процесса
  dashboard/server.js              100  локальная страница состояния
  texts/texts.js                     ~  единая точка доступа к текстам (загрузка, override, подстановка)
  texts/contract.js                  ~  контракт текстов: какие ключи и плейсхолдеры использует код
test/
  parser.test.js                   331  парсинг DOM-стратегий и нормализация
  embedded-json.test.js            320  парсинг реальной структуры, бюджеты, даты, категории
  store.test.js                    198  дедупликация, индекс, prune
  analyzer.test.js                 260  вердикты, черновик, HTML-сообщение
  scheduler.test.js                488  окно, интервал, стопы, источник
  cycle.test.js                    636  цикл целиком: идемпотентность, очередь, пагинация, очистка
  config.test.js                   366  конфиг, границы URL, секреты, команды
  boot.test.js                     123  сборка рантайма, восстановление состояния, уведомление о стопе
  fixtures/*.html                       7 сохранённых страниц
config/
  default.json                          все настройки
  performer-profile.json                профиль исполнителя (редактируемая копия)
  texts.json                            ВСЕ тексты интерфейса: Telegram, логи, CLI, анализ, черновик
docs/
  DEPLOY-VPS.md                         перенос на VPS: systemd, логи, бэкапы, безопасность
```

**Правило зависимостей (важно для навигации):**

```
util        ← ничего не импортирует из проекта (кроме util)
config      ← util
source      ← config, parser/anomaly-detector
parser      ← util, config (только normalize/embedded)
storage     ← ничего (чистые функции + fs)
analysis    ← parser (типы), ничего из source/telegram
telegram    ← util
scheduler   ← util, source (для SourceError/STOP_REASONS), parser (через инъекцию), storage
bot         ← config, scheduler (только чтение состояния)
index.js    ← всё (композиция)
```

Слои **не знают друг о друге через импорты**: `cycle.js` получает `source`, `parser`,
`store`, `notifier` аргументами. Это и есть причина, по которой тесты не ходят в сеть.

---

## 2. Сквозной поток данных

Один цикл (`runOnce` в `scheduler/cycle.js`) — это последовательность, которую полезно
держать в голове целиком:

```
1. flushPending()          досылаем то, что не ушло в прошлый раз (из state.json)
2. для каждого allowedUrl:
   2.1 pageUrlOf(entry, 1)              → https://kwork.ru/projects?c=38
   2.2 source.fetchPage(url)            → { html, status, softAnomalies }
       ├─ validateSourceUrl               (путь/хост/параметры)
       ├─ один GET, Authorization/cookies нет
       ├─ 429/403/401 → SourceError со stopReason → планировщик останавливается
       └─ detectPageAnomaliesDetailed     (реальная проверка? → SourceError CAPTCHA)
   2.3 parser.parse(html)               → { jobs, structure, pageInfo, warnings }
       ├─ embedded-json-parser: массив "wants" из inline-скрипта  ← основной путь
       ├─ иначе JSON-LD, иначе DOM-стратегии                     ← запасные пути
       └─ каждый job: нормализация полей, missingFields, dedupKey
   2.4 pageInfo.lastPage/total → сколько ещё страниц добрать (в пределах maxPagesPerUrl)
   2.5 фильтр по категориям (только если categoryMapping.confirmed)
   2.6 для каждого нового job:
       ├─ store.isProcessed(job)           повтор? → пропустить
       ├─ analyzeAndDraft(job, profile)    → analysis + draft
       ├─ renderJobMessages()              → 1..N HTML-блоков
       ├─ notifier.sendMessage(...)        ошибка? → в pendingNotifications, не записываем
       └─ store.record(job)                запись ТОЛЬКО после успешной отправки
3. store.prune(seenKeys, reliableSources)  удаляем задания, пропавшие из выдачи
4. один сводный лог на цикл
```

### Пример: что происходит с одной карточкой

**Шаг 1 — сырые данные из HTML** (реальная структура, `embedded-json-parser`):

```json
{ "id": 3259320, "name": "Поднять позиции сайта по SEO",
  "description": "Есть сайт themafia.by — важно добиться топ-1...",
  "priceLimit": "20000.00", "possiblePriceLimit": 20000, "isHigherPrice": false,
  "category_id": "37", "categoryLinksIdRu": 37, "status": "active",
  "date_create": "2026-09-26 01:26:34",
  "user": { "USERID": 10000001, "username": "test_client_one" } }
```

**Шаг 2 — нормализованное задание** (`jobFromWant` → `job`):

```json
{ "id": "3259320",
  "url": "https://kwork.ru/projects/3259320",
  "title": "Поднять позиции сайта по SEO",
  "budget": { "min": 20000, "max": 20000, "currency": "RUB", "text": "20000 ₽",
              "isRange": false, "isFrom": false, "sourceField": "priceLimit" },
  "publishedAt": { "text": "2026-09-26 01:26:34", "iso": "2026-09-25T22:26:34.000Z",
                   "origin": "fact:embedded-datetime", "confidence": "exact",
                   "timezone": "Europe/Moscow" },
  "category": { "id": "markup-by-layout", "label": "Вёрстка - Верстка по макету",
                "matchedBy": "kwork-category-id", "confidence": "high", "source": "kwork-id" },
  "kworkCategoryId": 37, "categoryLinkIds": [37],
  "client": { "name": "test_client_one", "meta": "https://kwork.ru/user/test_client_one" },
  "extra": { "status": "active", "maxDays": 10, "kworkCount": 0, "views": 1179,
             "offersCount": 1, "timeLeft": "1 д. 23 ч." },
  "dedupKey": "id:3259320", "dedupKind": "stable-id",
  "missingFields": [], "warnings": [],
  "provenance": { "sourceUrl": "https://kwork.ru/projects?c=38",
                  "strategy": "embedded-json:wants",
                  "extractedAt": "2026-10-07T15:00:00.000Z", "rawHtmlStored": false } }
```

**Шаг 3 — вердикт** (`analyzeJob` + `buildProposalDraft`):

```json
{ "verdict": "возможно", "preliminary": true,
  "profileCompleteness": { "complete": false,
    "missing": ["availability.hours_per_week", "availability.preferred_deadline_days"] },
  "pricing": { "known": true, "minimum": 2000,
    "text": "Предварительно: от 2000 ₽ (minimum_project_price профиля). Точная цена — после уточнения объёма.",
    "basis": "pricing.minimum_project_price", "warnings": [] },
  "estimate": { "known": false, "text": "Срок не оценивается: в профиле не задан желаемый срок...", "basis": null },
  "risks": [], "questions": [ ... 6 штук ... ],
  "draft": { "isDraft": true, "manualReviewRequired": true, "sentToKwork": false,
             "text": "Здравствуйте!\n\nПо заданию «...» — могу взять frontend-часть...",
             "assumptions": [...], "portfolioMentioned": [...] } }
```

**Шаг 4 — сообщение.** `renderJobMessages` возвращает массив HTML-блоков, упакованных под
лимит Telegram 4096 символов. Если карточка «богатая» (длинное описание + черновик),
получается 2 сообщения:

```
🔔 <b>Новое задание Kwork</b>
<b>Вёрстка лендинга по макету Figma</b>
<b>Рекомендация:</b> подходит (предварительно)

📌 <b>Факты из карточки</b>
• <b>Заголовок:</b> …
• <b>Ссылка:</b> https://kwork.ru/projects/884213/…
• <b>Бюджет:</b> 5 000 ₽
…
```

**Шаг 5 — состояние.** Запись в `processed-jobs.jsonl` и ключи в `seen-index.json`:

```json
{"recordedAt":"2026-10-07T16:24:12.948Z","id":"3259320",
 "url":"https://kwork.ru/projects/3259320","title":"Поднять позиции сайта по SEO",
 "dedupKey":"id:3259320","dedupKind":"stable-id","missingFields":[],
 "probableMatch":false,
 "payload":{"verdict":"возможно","preliminary":true,"risks":[],"notified":true,
            "modelUsed":false,"kworkCategoryId":37,"categoryLinkIds":[37]}}
```

---

## 3. Слой за слоем

### 3.1 Конфигурация — `src/config/load-config.js`

**Задача:** превратить `config/default.json` + переменные окружения в один объект `config`
и **не пропустить небезопасную настройку**.

```js
const { config, profile, validation } = loadConfig({
  rootDir,                       // корень проекта
  configFile: 'config/default.json',
  profileFile: 'config/performer-profile.json',
  env: process.env,
  requireLiveSource: false,      // true → требует source.enabled + permission.confirmed
  readEnvFile: true              // читать .env (тесты отключают)
});
```

**Что возвращается:**

| Ключ | Содержимое |
|---|---|
| `config` | весь JSON конфига + `rootDir`, `configPath`, `profilePath`, `profile`, `dataDir`, `secrets` |
| `config.secrets` | только секреты: `telegramBotToken`, `telegramAllowedUserId`, `telegramChatId`, `llmApiKey`, … |
| `validation` | `{ ok, errors[], warnings[] }` — конфиг + профиль вместе |

**Приоритет источников секретов:** `.env` → переменные процесса (окружение важнее).
Секреты **никогда** не читаются из `config/*.json`.

**Ключевые функции-стражи:**

| Функция | Что запрещает |
|---|---|
| `validateSourceUrl(url, {allowedUrls})` | не https, чужой хост, путь ≠ `/projects`, страницы заданий, незаявленные query-параметры |
| `isDeclaredPageVariant(url, allowedUrls)` | пускает ровно `объявленный URL + page=N` (порядок параметров не важен) |
| `validateConfig(config, {requireLiveSource})` | интервал вне 240–600, битый timezone, пейджинация без `pagination.enabled`, `source.enabled=false` при живом запуске |
| `validateTelegramSecrets` / `validateModelSecrets` | отсутствие токена/ключа там, где он нужен |

Пример из практики: `https://kwork.ru/projects?c=38&page=2` разрешён, если объявлен
`?c=38`; `?c=99&page=2` и `?c=38&page=2&evil=1` — отклоняются **до выхода в сеть**.

### 3.2 Утилиты

**`util/html.js`** — собственный HTML-парсер (без зависимостей):

```js
parseHtml(html)          → дерево: { type:'element', tag, attrs, children, parent, order }
findAll(root, predicate) → массив узлов (включая сам root!)
findElement(root, pred)  → первый узел
textOf(node)             → текст поддерева с нормализацией пробелов
classesOf(node)          → массив классов
```

Осторожно: `findAll` включает корневой узел в проверку — это используется в
`hasJobContent` (нужно, чтобы `data-budget` на самой карточке считался признаком).

**`util/time.js`** — работа со временем без библиотек. Всё через `Intl` с явной зоной:

```js
isWithinWindow(date, schedule)          // 05:00–19:00 Europe/Moscow
nextWindowStart(after, schedule)        // ближайшее открытие окна
chooseIntervalMs(240, 600, random)      // 240000..600000 мс включительно
planNextRequestWithHistory({...})       // решение: immediate | wait | nextWindow | paused
```

`planNextRequestWithHistory` — главная функция планирования. Возвращает одно из:

| `action` | Когда | Что делает планировщик |
|---|---|---|
| `immediate` | запросов ещё не было, `firstRequestNoDelay: true` | делает запрос сразу |
| `wait` | обычный случай | спит `waitMs`, затем запрос |
| `nextWindow` | пауза вывела бы за 19:00, или сейчас до 05:00 | спит до открытия окна |
| `paused` | после 19:00 | останавливается до утра |

**`util/logger.js`** — `createLogger({level})` + `redact()`. Редактируются: токен Telegram
(`123456789:AA…`), `sk-…`, `sk-ant-…`, `Bearer …`, `api_key=…`. Длинные строки обрезаются
до 200–500 символов, поэтому HTML в лог попасть не может.

### 3.3 Источник — `src/source/kwork-html-source.js`

```js
const source = new KworkHtmlSource({ allowedUrls, userAgent, timeoutMs, fetchImpl, logger });
await source.fetchPage('https://kwork.ru/projects?c=38');
// → { html, status, url, fetchedAt, bytes, softAnomalies, structureSignals }
```

**Что гарантирует:**

1. **Только GET.** Никаких POST/PUT — по grep в проекте есть ровно три POST: Telegram
   `sendMessage`, `getUpdates` и (выключенный) LLM-адаптер.
2. **Только объявленные URL** (+ их страницы `page=N`).
3. **Один запрос за раз:** если `inFlight === true`, второй вызов получает
   `SourceError` со `stopReason: 'config-error'`, а не второй запрос.
4. **Таймаут** через `AbortController` (по умолчанию 20000 мс).
5. **Стоп при защите:** 429, 403, 401/407 и реальная проверка по HTML → `SourceError`
   с `stopReason` из `STOP_REASONS`. Никаких ретраев внутри источника.
6. **Заголовки:** только `user-agent` и `accept`. Ни cookies, ни referer, ни
   `authorization` — это проверяется тестом.

**`SourceError`** — центральный тип ошибки источника:

```js
{ name:'SourceError', message, stopReason, retryable, httpStatus, details, diagnostics }
```

### 3.4 Парсеры

Порядок стратегий в `parseListingHtml` (первая успешная выигрывает, остальные не применяются,
чтобы не дублировать данные):

**1) Встроенный JSON — основной путь (`embedded-json-parser.js`).**

Наблюдаемая реальность: Kwork кладёт данные заданий в inline-скрипт страницы:

```html
<script>
  window.__INITIAL_STATE__ = {"projects":{"pagination":{"current_page":1,"last_page":2,"total":17,
    "per_page":12,"data":[…]},"wants":[{ id, name, description, priceLimit, … }]}};
</script>
```

Ключевые функции:

| Функция | Назначение |
|---|---|
| `extractEmbeddedWantsPayload(html)` | находит массивы `"wants":[…]` с балансировкой скобок/строк, берёт самый крупный |
| `sliceBalanced(text, start)` | вырезает сбалансированный JSON-фрагмент (корректно проходит `}` внутри строк) |
| `extractEmbeddedPagination(html)` | `{ currentPage, lastPage, total, perPage, nextPageUrl }` |
| `parseEmbeddedDate('2026-10-07 17:05:42', {timezone})` | МСК-время без зоны → точный ISO |
| `buildEmbeddedBudget(item)` | `priceLimit`/`possiblePriceLimit`/`isHigherPrice` → `{min,max,isFrom,text}` |
| `matchEmbeddedCategory(item, targets, mapping)` | сначала `category_id`, затем `categoryLinksIdRu` |
| `jobFromWant(item, context)` | нормализованное задание |

**Важная асимметрия:** если `category_id` есть, но не сопоставлен — категория **не**
угадывается по тексту. Иначе «Дизайн шаблона в Figma» попадал бы в «Вёрстку». Текстовая
подсказка работает только когда числового id нет вообще.

**2) JSON-LD** — `extractJsonLd` + `jobsFromJsonLd` (организация/JobPosting, если сайт отдаёт).

**3) DOM-стратегии** — `structure-detector.js`, поиск карточек по следам разметки:

| Стратегия | Признак |
|---|---|
| `data-want-id` | `data-want-id` + форма карточки |
| `data-project-id` | `data-project-id` / `data-job-id` |
| `class-want-card` | класс `want-card` / `js-want-card` |
| `class-project-card` | `project-card` / `want-card-inline` |
| `link-based` | контейнер формы карточки ровно с одной ссылкой `/projects/<id>` |

`hasJobContent(node)` требует «форму карточки»: заголовок (класс `*title*`, `<h1>`–`<h4>` или
текст единственной ссылки на задание) **и** деталь (описание/бюджет/дата/категория). Это
отсекает обёртку `<div class="want-card">` вокруг настоящей карточки.

**Нормализация (`normalize.js`)** — поле либо нормализовано, либо `null` + `missingFields`:

| Функция | Что делает |
|---|---|
| `parseBudget('от 2 000 до 4 000 ₽')` | `{min:2000,max:4000,currency:'RUB',isRange:true}`; строка без цифр → `null` |
| `parseRelativeDate('8 минут назад')` | производная дата (`origin: 'derived:relative'`); «сегодня» → ISO `null` |
| `buildPublishedAt({datetimeAttr, text})` | ISO-атрибут → факт; иначе безопасный разбор текста |
| `matchTargetCategory(text, categories, declared)` | сначала объявленная категория, потом подсказки; при равной длине — меньший `priority` |
| `extractJobId(url)` | числовой id из `/projects/<id>/…` |
| `PROJECT_HREF_PATTERN` / `isProjectLink` | единый шаблон ссылки на задание (абсолютной и относительной) |

**Детектор защиты (`anomaly-detector.js`)** — самое важное различие проекта:

| Жёсткий признак (остановка) | Мягкий признак (просто игнорируется) |
|---|---|
| видимый `g-recaptcha`/`h-captcha`/`cf-turnstile` или их iframe | слово `captcha` в `<script>` |
| видимое поле ввода кода | скрытый контейнер (`display:none`) |
| заголовок/`<h1>`: «Подтвердите, что вы не робот», «Проверка безопасности», «Just a moment», «Too many requests» | упоминание в скрипте `window.recaptcha_pubkey` |
| тексты «доступ запрещён», «вы заблокированы», «слишком много запросов» | |

Живая проверка показала: у Kwork на обычной странице есть только `window.recaptcha_pubkey`
в скрипте — до этой правки бот останавливался на нормальной странице.

### 3.5 Хранилище — `src/storage/job-store.js`

**Три файла и их роли:**

| Файл | Что хранит | Перезаписывается |
|---|---|---|
| `seen-index.json` | **текущие** задания: ключи дедупликации + метаданные | целиком, атомарно (tmp + rename) |
| `processed-jobs.jsonl` | журнал добавлений (append-only), история | только дозаписывается |
| `state.json` | состояние планировщика, очередь отправки, причина стопа | целиком, атомарно |
| `messages-log.jsonl` | факт отправки: `parts`, длина, вердикт | только дозаписывается |

**Форма `seen-index.json`:**

```json
{ "version": 1,
  "keys": {
    "stableId": { "3259320": { "dedupKey": "id:3259320", "title": "…",
                               "recordedAt": "2026-10-07T16:24:12.948Z",
                               "sourceUrl": "https://kwork.ru/projects?c=38",
                               "kworkCategoryId": 37 } },
    "url": {}, "composite": {} },
  "total": 4, "updatedAt": "2026-10-07T16:24:12.965Z" }
```

**Один ключ на задание** (`keyForJob`): приоритет `stable-id` (числовой id) → `url`
(ссылка без query) → `composite` (хеш заголовка и бюджета, помечается `probableMatch`).
Ссылка не создаёт второй ключ: иначе число записей в индексе вдвое превышало число задач.

### Один ключ на задание

Задание регистрируется в индексе **ровно под одним ключом**:

| Приоритет | Тип ключа | Когда используется |
|---|---|---|
| 1 | `stable-id` | у задачи есть числовой id (обычный случай) |
| 2 | `url` | id нет, но есть ссылка (приводится к виду без query) |
| 3 | `composite` | нет ни id, ни ссылки — хеш заголовка и бюджета, помечается `probableMatch` |

У задач Kwork всегда есть id, поэтому на практике весь индекс — это поле `stableId`.
Раньше задание писалось и под id, и под ссылку, из-за чего `stats.keyTotal` был вдвое
больше `stats.total` и цифры в статистике вводили в заблуждение. Теперь они совпадают.

```bash
node src/index.js status
node -e "const i=require('./data/seen-index.json'); console.log(i.total, Object.keys(i.keys.stableId).length + Object.keys(i.keys.url).length + Object.keys(i.keys.composite).length)"
```

Старый индекс продолжает работать: `checkDuplicate()` дополнительно проверяет поле `url`,
поэтому повторы распознаются. Привести данные к новому виду можно командой `reset`.

Функции: `keyForJob(job)` — единственный ключ, `indexFieldFor(type)` — поле индекса,
`checkDuplicate(job, index)`, `activeJobCount(index)`, `store.stats.keyTotal`.

**`record(job)`** — идемпотентная запись: если `isProcessed` вернул дубликат, ничего не
меняется. **`prune(...)`** — очистка:

```js
await store.prune({ seenKeys, reliableSourceUrls });
// reliableSourceUrls: только те URL, что в этом проходе получены и разобраны
// записи без sourceUrl (старый формат) НЕ удаляются
```

Это защита от сценария «сеть упала → база опустела → повторные уведомления».

### 3.6 Анализатор — `src/analysis/analyzer.js`

**Философия:** анализатор не «оценивает», а **собирает доказательства**.

```js
analyzeJob(job, profile) → {
  verdict,                    // 'подходит' | 'возможно' | 'не подходит' | 'нужно уточнить'
  preliminary,                // true, если профиль заполнен не полностью
  profileCompleteness,        // { complete, missing: [...] }
  facts,                      // [{ field, value, source }] — только из карточки
  inferences,                 // { positive[], negative[], summary, modelSummary? }
  risks,                      // [{ code, message, evidence }]
  unknown,                    // что неизвестно: строки
  questions,                  // вопросы заказчику (≤ 6)
  estimate,                   // срок: { known, text, basis }
  pricing,                    // цена: { known, minimum, text, basis, warnings }
  assumptions,                // допущения
  matchedKeywords, negativeKeywords, excludedWork, budget
}
```

**Логика вердикта (буквально):**

```js
const blockingRisks = risks.filter((risk) =>
  BLOCKING_RISKS.has(risk.code) ||                       // excluded_work, backend_requested
  (risk.code === 'budget_below_minimum' && budgetAssessment.belowMinimum)
);
if (blockingRisks.length > 0)                       verdict = 'не подходит';
else if (positiveSkills.length > 0 && job.category) verdict = risks.length > 2 ? 'возможно' : 'подходит';
else if (positiveSkills.length > 0 || job.category) verdict = 'возможно';
else if (!job.title)                                verdict = 'нужно уточнить';
```

**Обработка отрицаний** (`findNegatedMentions`): «Backend не требуется» не считается
запросом backend — отрицание ищется и перед упоминанием, и после него
(`не`, `без`, `нет`, `no`). Такие фразы попадают в `risks` с кодом `explicitly_excluded`
(информационный, не блокирующий) и в `unknown`.

**`assessBudget`**: сравнивает бюджет с `pricing.minimum_project_price` и стартовыми ценами
услуг; чужая валюта → сравнение не выполняется, это уходит в `unknown`.

**`buildProposalDraft`**: собирает черновик из фактических данных профиля. Ключевые запреты:
не называет фиксированную цену и срок до уточнения объёма, упоминает только работы из
`portfolio`, всегда содержит строку «Черновик для ручной проверки» и `sentToKwork: false`.

### 3.7 Telegram

**`format.js` — построение сообщения из блоков:**

```js
buildJobSections(job, analysis) → ['🔔 <b>Новое задание Kwork</b>…', '📌 <b>Факты…</b>', …]
packSections(sections)          → ['часть 1', 'часть 2']   // не режет теги
renderJobMessages(job, analysis) → массив готовых к отправке HTML-частей
renderJobMessage(job, analysis)  → тот же текст без тегов (dry-run, логи)
```

Все значения экранируются (`&`, `<`, `>`). Предел: `TELEGRAM_LIMIT = 4096`,
`PACK_LIMIT = 4032`. Длинный блок режется по строкам, поэтому `<b>` не разрывается.

**`client.js`:**

```js
const client = new TelegramClient({ token, allowedUserId, chatId, logger });
await client.sendMessage(html, { parseMode: 'HTML' });   // HTML по умолчанию
const messages = await client.pollOnce({ timeoutSeconds: 30 });
```

Бот отвечает только `TELEGRAM_ALLOWED_USER_ID`. Конфликт `getUpdates` («terminated by other
getUpdates request») распознаётся отдельно и превращается в понятное сообщение — это значит,
что запущена вторая копия бота с тем же токеном.

**`state.js`** — `data/telegram-state.json`:

```json
{ "offset": 123456, "chatId": 987654321, "updatedAt": "2026-10-07T16:00:00.000Z" }
```

Зачем: режим `poll` (без приёма команд) должен знать, куда отправлять. Если chat id
неизвестен, `poll` отказывается стартовать, а не теряет уведомления молча.

### 3.8 Планировщик — `src/scheduler/scheduler.js` + `cycle.js`

**Состояния** (`SCHEDULER_STATE`): `idle` → `running` → `paused` / `stopped`.

**Один шаг (`tick`) и один запрос:**

```js
async tick() {
  if (pausedByUser) → { action: 'paused' }
  const decision = planNextRequestWithHistory({ now, schedule, hasPriorRequest, lastRequestAt });
  switch (decision.action) {
    case 'immediate':  → runRequest()            // первый запрос без паузы
    case 'wait':       → sleep(waitMs) → runRequest()
    case 'nextWindow': → ждать до 05:00
    case 'paused':     → остановиться до утра
  }
}
async runRequest() {
  try   { outcome = await onCycle(); сбросить счётчики ошибок }
  catch { 429/CAPTCHA/403/… → stop(reason); retryable → счётчик, после 3 — stop }
}
```

**Политика ошибок:**

| Событие | Реакция |
|---|---|
| HTTP 429, 403, CAPTCHA, blocked, bot-check, access-denied | `stop()` немедленно, без повторов |
| Сетевая/retryable ошибка | счётчик `consecutiveNetworkErrors`; ≥ 3 → стоп |
| Разметка не разобрана (`structureOk: false`) | счётчик `consecutiveStructureErrors`; ≥ 3 → пауза (`structure-changed`) |
| Пользователь `/pause` | `pausedByUser = true`, запросы не выполняются |

**`createScheduler` (в `index.js`)** восстанавливает `lastRequestAt` из `state.json` и
передаёт `onStop`, который пишет `lastStop` и **уведомляет пользователя в Telegram** с
диагностикой (HTTP-статус, размер, заголовок, маркеры, короткий фрагмент).

**Почему «в том же запросе» невозможно.** Kwork отдаёт список целиком в одном HTML;
несколько страниц в одном ответе не приходят. Поэтому пагинация реализована как
«дополнительные URL в том же списке запросов»: `?c=38&page=2` — отдельный одиночный GET
со своей паузой 240–600 с. Глубина берётся из `pagination.last_page` самой выдачи.

### 3.9 Бот и команды — `src/bot/kwork-watcher-bot.js`

```js
const result = dispatchCommand('/status', { config, profile, store, schedulerState, scheduler });
// → { action: null | 'pause' | 'resume', reply: '…' }
```

`dispatchCommand` — **чистая функция**, поэтому тестируется без Telegram. Команды:
`/start`, `/help`, `/status`, `/plan`, `/profile`, `/pause`, `/resume`.

`KworkWatcherBot` держит два независимых цикла (запускаются `Promise.all`):
планировщик (`scheduler.run()`) и приём команд (`pollCommands()`). Параллельными они
безопасны, потому что запросы к Kwork делает только планировщик.

`preflight(config, {requireLiveSource})` — последняя проверка перед живым запуском.

---

## 4. Инварианты, которые нельзя ломать

Это ядро проекта. Если меняете код — проверьте, что инвариант цел; каждый закреплён тестом.

| № | Инвариант | Где живёт | Чем проверяется |
|---|---|---|---|
| 1 | **Только объявленные URL, только GET, без авторизации** | `validateSourceUrl`, `isDeclaredPageVariant`, `fetchSinglePage` | `config.test.js` (границы URL), `scheduler.test.js` (нет cookies/authorization) |
| 2 | **Один запрос одновременно** | `KworkHtmlSource.inFlight` | `scheduler.test.js` «запрещает параллельные запросы» |
| 3 | **Случайная пауза 240–600 с перед каждым следующим запросом; первый — без паузы** | `chooseIntervalMs`, `planNextRequestWithHistory` | `scheduler.test.js` (4 теста) |
| 4 | **Окно 05:00–19:00 Europe/Moscow; запрос не начинается, если пауза выводит за 19:00** | `isWithinWindow`, `planNextRequest` | `scheduler.test.js`, `config.test.js` |
| 5 | **429/CAPTCHA/блокировка → немедленный стоп, без ускоренных повторов** | `HARD_STOP_REASONS`, `stop()` | `scheduler.test.js` |
| 6 | **Реальная проверка ≠ упоминание в скрипте** | `anomaly-detector.js` | `parser.test.js` (2 фикстуры) |
| 7 | **Отсутствующее поле → `null` + `missingFields`, никогда не выдумывается** | `normalize.js`, `embedded-json-parser.js` | `embedded-json.test.js`, `parser.test.js` |
| 8 | **Повторная карточка не создаёт дубликат и не отправляется дважды** | `checkDuplicate`, `record` | `cycle.test.js`, `store.test.js` |
| 9 | **Запись в хранилище только после успешной отправки; неудача → очередь** | `cycle.js` | `cycle.test.js` (2 теста) |
| 10 | **Очистка индекса только по надёжным источникам** | `pruneIndex`, `reliableSourceUrls` | `store.test.js`, `cycle.test.js` |
| 11 | **HTML не сохраняется** | `provenance.rawHtmlStored: false`, `rawHtmlRetention: discard` | `parser.test.js` |
| 12 | **Секреты только из окружения, не в логах и не в git** | `loadConfig`, `redact`, `.gitignore` | `config.test.js` (3 теста) |
| 13 | **Факты / выводы / неизвестное разделены в сообщении** | `buildJobSections` | `analyzer.test.js`, `cycle.test.js` |
| 14 | **Черновик не отправляется на Kwork** | `proposal-draft.js`, отсутствие POST на Kwork | `analyzer.test.js` (`sentToKwork: false`) |
| 15 | **Живой запуск только после явного подтверждения** | `preflight`, `validateConfig({requireLiveSource})` | `config.test.js` |
| 16 | **Тексты только из `texts.json`; плейсхолдеры не теряются** | `src/texts/*`, `config/texts.json` | `texts.test.js` |
| 17 | **Никаких новых хостов и POST на Kwork; секреты и HTML не в логах** | белый список хостов, `redact` | `security.test.js` |
| 18 | **Подписи метрик совпадают с данными (предложения ≠ заказы)** | `telegram/format.js`, `texts.json` | `security.test.js` |
| 19 | **Границы окна сообщаются в чат один раз на переход** | `trackWindowBoundary`, `windowOpen` в состоянии | `scheduler.test.js` |
| 20 | **Цена и срок считаются от ставки профиля; без ставки цифры не выдумываются** | `rate-estimator.js`, профиль | `rates.test.js` |
| 21 | **В отклике нет внутренних имён проекта** | `findInternalKeys`, `INTERNAL_KEYS` | `rates.test.js` |
| 22 | **«Макет посмотрел» — только если ссылка есть в тексте задания** | `job-signals.js` | `rates.test.js` |

**Если сомневаетесь, можно ли что-то менять** — вопрос звучит так: «нарушает ли это
инвариант и останется ли соответствующий тест зелёным?» Если тест придётся ослабить,
изменение, скорее всего, противоречит согласованному объёму доступа.

---

## 5. Справочники: перечисления, формы данных, лимиты

### `STOP_REASONS` (`source/kwork-html-source.js`)

| Значение | Когда | Жёсткий стоп? |
|---|---|---|
| `http-429` | HTTP 429 | да |
| `http-403` | HTTP 403 | да |
| `captcha` | показана проверка | да |
| `blocked` | текст блокировки | да |
| `bot-check` | «проверка безопасности» | да |
| `access-denied` | 401/407, «доступ запрещён» | да |
| `network-errors` | 3 сетевые ошибки подряд | да (пауза) |
| `structure-changed` | 3 раза не разобралась выдача | да (пауза) |
| `config-error` | URL/настройки не прошли проверку | да |
| `paused-by-user` | `/pause` | нет (ждёт `/resume`) |
| `window-closed` | после 19:00 | нет (ждёт утра) |

### `RISK` коды (`analysis/analyzer.js`)

| Код | Блокирует вердикт | Смысл |
|---|---|---|
| `excluded_work` | **да** | пересечение с `excluded_work`/`negative_keywords` |
| `backend_requested` | **да** | запрошены серверные работы/API |
| `budget_below_minimum` | да, если `belowMinimum` | бюджет ниже минимальной цены профиля |
| `cms_mentioned` | нет | упоминание CMS → вопрос заказчику |
| `budget_absent`, `budget_not_fixed` | нет | бюджет не указан / не в рублях |
| `no_layout` | нет | нет упоминания Figma/PSD |
| `vague_scope` | нет | «доработка» без деталей |
| `urgent` | нет | признаки срочности |
| `missing_fields` | нет | список отсутствующих полей |
| `out_of_target_categories` | нет | категория не определена |
| `dedup_composite_key` | нет | нет стабильного ключа |
| `explicitly_excluded` | нет | в задании прямо сказано «не требуется» |

### `missingFields` — возможные значения

`url`, `title`, `description`, `budget`, `publishedAt`, `declaredCategory`, `clientName`.

### `provenance` / `origin` — откуда взялось значение

| Значение | Смысл |
|---|---|
| `fact:embedded-datetime` | точное время из JSON-поля `date_create` |
| `fact:datetime-attribute` | точное время из `datetime` |
| `derived:relative` | пересчитано из «8 минут назад» — производное |
| `derived:absolute` | разобрано из «12.05.2026» |
| `fact:text` | только текст, ISO нет |
| `confidence`: `exact` / `date-only` / `year-unknown` / `derived` / `imprecise` / `unknown` | насколько можно доверять |

### Лимиты и константы

| Константа | Значение | Где |
|---|---|---|
| `minIntervalSeconds` / `maxIntervalSeconds` | 240 / 600 | `config.schedule` |
| `firstRequestNoDelay` | true | `config.schedule` |
| `maxPagesPerUrl` | 3 (жёсткий предел 20) | `config.source.pagination`, `HARD_PAGE_LIMIT` |
| `consecutiveNetworkErrorLimit` | 3 | `config.schedule.failurePolicy` |
| `consecutiveStructureErrorLimit` | 3 | там же |
| `PENDING_LIMIT` | 50 | `scheduler/cycle.js` |
| `TELEGRAM_LIMIT` / `PACK_LIMIT` | 4096 / 4032 | `telegram/format.js` |
| `requestTimeoutMs` | 20000 | `config.source` |

---

## 6. Файлы состояния и форматы

Все файлы — в `data/` (папка в `.gitignore`).

```
data/
  seen-index.json         текущие задания (ключи дедупликации + sourceUrl + категория)
  processed-jobs.jsonl    журнал: что и когда добавлено (append-only)
  messages-log.jsonl      журнал отправок: parts, длина, notified
  state.json              планировщик + очередь отправки + причина стопа
  telegram-state.json     offset и chatId
```

**`state.json` — полная форма:**

```json
{ "scheduler": { "status": "running", "stopReason": null, "stopMessage": null,
                 "requestCount": 1, "lastRequestAt": "2026-10-07T16:15:52.000Z",
                 "nextRequestAt": "2026-10-07T16:24:00.000Z" },
  "pendingNotifications": [ { "jobId": "3264800", "url": "…", "title": "…",
                              "verdict": "подходит", "messages": ["<b>…</b>"],
                              "failedAt": "…", "reason": "Telegram недоступен" } ],
  "lastStop": { "reason": "captcha", "message": "…", "at": "…",
                "diagnostics": { "status": 200, "bytes": 252917, "title": "…",
                                 "markers": ["captcha-heading"], "excerpt": "…" } },
  "updatedAt": "2026-10-07T16:24:00.000Z" }
```

`pendingNotifications` — очередь недоставленного. Размер ограничен 50: если Telegram
недоступен долго, самые старые теряются, но очередь не растёт бесконечно.

**Как читать состояние:**

```bash
node src/index.js status          # активные задания, состояние планировщика, последние записи
cat data/state.json
node -e "console.log(require('./data/seen-index.json').total)"
```

---

## 7. CLI: режимы, побочные эффекты, коды возврата

| Команда | Сеть | Пишет в `data/` | Exit |
|---|---|---|---|
| `plan` | нет | нет | 0 |
| `config-check [--live]` | нет | нет | 0 — ок, 2 — ошибки |
| `dry-run [--fixtures=DIR]` | нет | создаёт `data/` (пустую) | 0 |
| `categories` | нет | нет | 0 |
| `status` | нет | создаёт `data/` | 0 |
| `reset [--yes] [--hard]` | нет | удаляет индекс, состояние и журнал сообщений; с `--hard` — историю обработки | 0 / 2 без `--yes` |
| `poll` | **да** | да | 0 / 2 (не готов) |
| `bot` | **да** | да | 0 / 2 |
| `dashboard [--port=] [--host=]` | нет | нет | живёт до сигнала |
| `help` | нет | нет | 0 / 1 |

**`--live`** у `config-check` включает проверки живого запуска (`source.enabled`,
`permission.confirmed`, пейджинация, интервал).

**Почему `poll` может отказаться стартовать:** нет `TELEGRAM_BOT_TOKEN`/`ALLOWED_USER_ID`
(exit 2), неизвестен chat id (exit 2), `source.enabled = false` (exit 2), интервал вне
240–600 (exit 2). Это намеренное поведение: лучше явная ошибка, чем тихая потеря уведомлений.

---

## 8. Как расширять: типовые задачи

> Более короткие пошаговые рецепты (тексты, черновик, расписание, категории, LLM, подмена
> канала, новые проверки безопасности) — в разделе [15. Рецепты модификаций](#15-рецепты-модификаций).

### 8.1 Добавить категорию

1. `config/default.json` → `targetCategories`: новая запись с `id`, `label`, `priority`
   (меньше = приоритетнее при равных совпадениях текста), `matchHint`.
2. Если известен числовой `kworkCategoryId` — вписать; иначе оставить `null`.
3. `node src/index.js categories` → посмотреть, какие `category_id` встречаются.
4. `categoryMapping.byCategoryId` → `{ "<id Kwork>": "<ваш id>" }`.
5. Проверить: `node --test test/embedded-json.test.js`.

### 8.2 Парсить новое поле из Kwork

1. Найти поле в payload (в живом HTML или в фикстуре).
2. `embedded-json-parser.js` → `jobFromWant`: добавить поле, **сохраняя исходное значение**.
3. Если поле может отсутствовать — добавить в `missingFields`.
4. Если это дата — через `parseEmbeddedDate`; если деньги — через `buildEmbeddedBudget`.
5. Показать в сообщении: `telegram/format.js` → `buildJobSections`.
6. Тест: `embedded-json.test.js` (фикстура с полем и без него).

### 8.3 Подключить LLM

```bash
# .env
MODEL_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=...
LLM_MODEL=deepseek-chat
```

`model-adapter.js` возвращает **только** `summary`, `notes`, `extraQuestions` — он физически
не может изменить факты, риски, цену и черновик. При ошибке/таймауте анализ продолжается на
эвристике. Проверить: `node src/index.js config-check`.

### 8.4 Поменять стиль черновика

`config/performer-profile.json` → `proposal_preferences.tone` (`professional_friendly`,
`professional`, `friendly`), `must_mention`, `must_avoid`, `questions_before_quote`.
Логика: `analysis/proposal-draft.js` (генерация) и `analyzer.buildQuestions` (вопросы).

### 8.5 Настроить расписание и глубину

```json
"schedule": { "windowStart": "09:00", "windowEnd": "19:00",
              "minIntervalSeconds": 300, "maxIntervalSeconds": 600,
              "firstRequestNoDelay": false },
"source":   { "pagination": { "enabled": true, "maxPagesPerUrl": 5 } }
```

Помните: `minIntervalSeconds` не может быть меньше 240 — это проверяет `validateConfig`.
Множитель запросов: `URL × страницы` за цикл.

### 8.6 Заменить Telegram на другой канал

Реализуйте объект с методом `sendMessage(text, {parseMode})` и передайте его как
`notifier` в `createCycleRunner` (см. `NullNotifier` как образец). Больше ничего менять не
нужно: `cycle.js` знает только этот интерфейс.

### 8.7 Добавить блок в сообщение

1. `telegram/format.js` → `buildJobSections`: добавить блок (не забыть `escapeHtml`).
2. Проверить, что `<b>` закрывается: тест «опасные символы экранируются».
3. Проверить лимит: `packSections` сам разобьёт, но тест на 4096 останется зелёным.

---

## 9. Диагностика: что делать, если…

### Задач приходит меньше, чем видно на сайте

1. `node src/index.js categories` — сколько задач и какие категории в индексе.
2. Смотрим сводный лог: `Цикл завершён: … | c=38: карточек 12 (страниц 2)`. Это одна строка
   на цикл; если в ней есть `предупреждений N` или `ошибок N`, ниже идут их расшифровки:
   `Предупреждение цикла: …` (уровень warn) и `Ошибка цикла: …` (уровень error).
3. Если есть строка `в выдаче заявлено 17 заданий, забрано 12` — увеличьте
   `source.pagination.maxPagesPerUrl` и/или проверьте, что включён `pagination.enabled`.
4. Учтите: часть заданий истекает (`extra.timeLeft`), поэтому «на сайте 35, в боте 29»
   может быть честной разницей по времени.

### Сообщения вообще не приходят

1. `cat data/state.json` → `pendingNotifications`: если там записи — Telegram недоступен
   или chat id неверный.
2. `node src/index.js status` → есть ли активные задания в индексе.
3. Проверить, что вы запускаете `bot`/`poll` (а не `dry-run`), и что chat id известен.
4. Если в логе `Conflict: terminated by other getUpdates` — запущена вторая копия бота с
   тем же токеном, Telegram отдаёт обновления только одной.

### «Ожидание открытия окна опроса»

Это не ошибка: либо сейчас до 05:00 МСК, либо пауза вывела бы запрос за 19:00. Бот ждёт
открытия окна и не тратит запросы. Проверить время:

```bash
TZ=Europe/Moscow date
```

### Бот остановился, в Telegram пришла диагностика

Смотрим `reason`:

- `captcha` / `blocked` / `bot-check` / `http-429` — сайт ограничил доступ. Ничего не делаем
  автоматически; проверьте страницу вручную и, если всё в порядке, `/resume`. Меняйте частоту
  только осознанно (и это изменение объёма доступа).
- `structure-changed` — сменилась разметка. Загляните в `data/state.json` → `lastStop.diagnostics`
  (заголовок, маркеры, фрагмент). Фикстуру и парсер нужно обновить вручную.
- `network-errors` — сеть. Проверьте подключение, затем `/resume`.

### Подозрение, что парсер теряет карточки

```bash
node src/index.js dry-run                       # на сохранённых fixtures
node -e "…"                                     # см. раздел 11: ручной разбор HTML
```

Ключевой вопрос: сколько массивов `"wants"` в HTML и совпадает ли их содержимое. Если
массивов несколько, берётся самый крупный (`extractEmbeddedWantsPayload`).

### В индексе остались старые двойные ключи

До перехода на один ключ задание хранилось дважды (по id и по ссылке). Повторы
распознаются и так, но статистика завышена, пока данные не пересобраны:

```bash
node src/index.js reset --yes     # очистить индекс и состояние
node src/index.js poll            # или bot: запуск соберёт задания заново
```

История обработки (`processed-jobs.jsonl`) сохраняется; с `--hard` удаляется и она.

### Нужно понять, откуда взялось конкретное значение

Смотрим `provenance`/`origin` в задании (`rawHtmlStored: false` — HTML нигде не сохранён) и
строку `source` в `facts` внутри анализа.

### Хочется посмотреть всё «как в бою», но без сети

```bash
node src/index.js dry-run
node src/index.js dashboard --port=8787    # http://127.0.0.1:8787
```

---

## 10. Тесты

```bash
node --test                                  # всё (325 тестов)
node --test test/cycle.test.js               # один файл
node --test test/texts.test.js test/security.test.js   # тексты и безопасность
node --test --test-name-pattern="пагинац"    # тесты по подстроке имени
```

| Файл | Что закрывает |
|---|---|
| `parser.test.js` | DOM-стратегии, нормализация, отсутствующие поля, детектор защиты, диагностика |
| `embedded-json.test.js` | реальная структура `wants`, бюджеты, даты, категории, испорченный JSON |
| `store.test.js` | дедупликация, форма индекса, `pruneIndex`, `activeJobCount` |
| `analyzer.test.js` | вердикты, отрицания, бюджет, черновик, HTML-сообщение и экранирование |
| `scheduler.test.js` | интервал, окно, паузы, стопы, источник, страницы `?page=` |
| `cycle.test.js` | идемпотентность, очередь отправки, пагинация, очистка, сводный лог |
| `config.test.js` | границы URL, интервалы, секреты, команды, `/status` |
| `boot.test.js` | сборка рантайма, восстановление `lastRequestAt`, уведомление о стопе |
| `texts.test.js` | контракт текстов, плейсхолдеры, локальный override, отсутствие незаполненных `{}` |
| `security.test.js` | секреты в логах, белый список хостов, отсутствие POST на Kwork, HTML в файлах, подписи метрик и заказчика |
| `model.test.js` | бюджет запросов, сброс по суткам и часам, классификация ошибок, выборочный вызов, расход в `/status` |
| `telegram-users.test.js` | реестр пользователей, `/start`, `/approve`, `/deny`, `/users`, публикация меню команд |
| `telegram-commands.test.js` | разметка ответов на все команды, права владельца, два набора меню, область публикации, идемпотентность публикации |
| `profiles.test.js` | приоритет личного профиля, битый файл, пригодность, напоминания, анализ на каждого пользователя |
| `profile-upload.test.js` | `/profile upload`, приём файла, отклонение битого, `/profile template`, сброс |
| `profile-guard.test.js` | защита загрузки: тип, размер, глубина до парсинга, прототипы, лимиты, разметка, частота |
| `categories.test.js` | каталог, персональный выбор, приоритет над общими, фильтр, команда `/categories` |
| `category-catalog.test.js` | разбор страницы, 54 категории и 219 подразделов, URL-связь, поиск с ё/е и й/и, имена в задании |
| `poll-plan.test.js` | режимы плана, ограничение объявленными URL, сохранение пагинации, `/plan` |
| `rates.test.js` | оценка от ставки, срочность, минимальный режим, черновик без внутренних ключей, «макет посмотрел» только по ссылке |

**Как писать новый тест:**

1. Если нужен HTML — положите фикстуру в `test/fixtures/` (не ходите в сеть!).
2. Для цикла используйте `makeRunner`/`makeNotifier` из `cycle.test.js`; временную папку
   создаёт `mkdtemp`, поэтому рабочий `data/` не затрагивается.
3. Инъекции для детерминизма: `now`, `sleep`, `random`, `fetchImpl`.
4. Проверяйте **поведение**, а не реализацию: «задание не отправлено второй раз», «индекс
   не очищен при сбое», а не «вызвана такая-то функция».

---

## 11. Инструменты разработчика

**Ручной разбор живого HTML** (один запрос, не забывайте про паузы и окно):

```js
// /tmp/probe.mjs
import { fetchSinglePage } from '/путь/src/source/kwork-html-source.js';
import { extractEmbeddedPagination, extractEmbeddedWantsPayload } from '/путь/src/parser/embedded-json-parser.js';

const res = await fetchSinglePage('https://kwork.ru/projects?c=38', {
  allowedUrls: [{ url: 'https://kwork.ru/projects?c=38' }],
  userAgent: 'kwork-watcher-bot/0.1'
});
console.log(extractEmbeddedPagination(res.html));            // { currentPage, lastPage, total }
console.log(extractEmbeddedWantsPayload(res.html).items.length);
```

**Прогон цикла без Telegram и без сети:**

```js
const runner = createCycleRunner({ source: fakeSource, parser, store, profile, config, notifier: null });
const summary = await runner.runOnce();   // summary: cardsFound, newJobs, duplicates, pruned, sources
```

**Проверить один парсер на строке:**

```js
import { KworkListingParser } from './src/parser/job-parser.js';
const parser = new KworkListingParser({ targetCategories, categoryMapping });
const result = parser.parse(html, { sourceUrl: 'https://kwork.ru/projects' });
```

**Проверить решение планировщика:**

```js
import { planNextRequestWithHistory } from './src/util/time.js';
planNextRequestWithHistory({ now: new Date('2026-10-07T07:00:00Z'), schedule, hasPriorRequest: false });
```

**Правило живых проверок.** Один запрос за раз, пауза 240–600 с, только в окне 05:00–19:00
МСК, только объявленные URL. Диагностические скрипты не должны сохранять HTML и не должны
запускаться «в фоне» — после проверки убедитесь, что процесса не осталось:

```bash
pgrep -fl "src/index.js (poll|bot|dashboard)"
```

---

## 12. Тексты интерфейса

Все формулировки, которые видит человек, лежат в **одном файле**: `config/texts.json`.
Код отвечает за структуру и данные, тексты — за слова.

### 12.1 Как это устроено

```
config/texts.json                     база: ключи и плейсхолдеры
config/local.texts.json               необязательный локальный файл (TEXTS_FILE в .env)
        ↓ deepMerge (локальный важнее)
src/texts/texts.js → createTexts()    объект texts на весь процесс
        ↓ передаётся аргументом
format.js, analyzer.js, proposal-draft.js, cycle.js, scheduler.js,
bot/kwork-watcher-bot.js, index.js, dashboard/server.js, parser, model-adapter
```

API объекта текстов:

| Метод | Назначение | Пример |
|---|---|---|
| `t(path, params)` | строка с подстановкой `{name}` | `texts.t('logs.indexPruned', { removed: 3, active: 32 })` |
| `lines(path, params)` | массив строк-шаблонов | `texts.lines('cli.help')` |
| `raw(path)` | значение как есть (без подстановки) | `texts.raw('telegram.sections.facts')` |
| `choose(path, {params, context})` | выбор варианта (строка / массив / массив с `when`) | `texts.choose('proposal.scopeItems.markup')` |
| `parametrized(path, params)` | объект, где листья — отформатированные строки | `texts.parametrized('commands.plan')` |

Правила:

- **плейсхолдеры не удалять**: `{count}`, `{url}`, `{reason}` и т. п. подставляет код.
  Если плейсхолдер пропадёт, тест «плейсхолдеры в текстах совпадают с ожиданиями кода» упадёт;
- если ключа нет, `t()` вернёт сам путь — это заметно сразу, но бота не роняет;
- значения экранируются для Telegram там, где это нужно (`escapeHtml`), поэтому в сам
  `texts.json` HTML-теги лучше не писать, кроме случаев, когда разметка нужна
  (например, `telegram.sections.facts` начинается с `📌 <b>…</b>`).

### 12.2 Что именно вынесено

| Раздел `texts.json` | Что содержит |
|---|---|
| `telegram.*` | заголовки, подписи фактов, «не указано», формулировки рисков/выводов |
| `commands.*` | ответы на `/start`, `/status`, `/plan`, `/profile`, `/pause`, `/resume`, предупреждение об остановке |
| `logs.*` | сводка цикла, сообщения о паузах/окне, ошибки отправки, конфликт Telegram |
| `cli.*` | вывод `status`, `categories`, `dry-run`, `config-check`, справка, сообщение об ошибке |
| `dashboard.*` | заголовки и подписи локальной страницы |
| `analysis.*` | вердикты, коды рисков, заметки о бюджете, «неизвестное», допущения, вопросы, сводка |
| `proposal.*` | приветствие, структура черновика, формулировки объёма и допущений |
| `source.*`, `scheduler.*` | сообщения источника и планировщика |
| `parser.*` | предупреждения парсера и подписи стратегий |
| `model.*` | промпт, системная строка, логи и сообщения об ошибках адаптера модели |
| `commands.onboarding.*` | регистрация, запрос доступа, подтверждение, отказ, список пользователей |
| `commands.telegramMenu` | общий список команд для меню Telegram |
| `commands.telegramMenuOwner` | расширенный список команд для чата владельца |
| `window.*` | сообщения при открытии и закрытии окна опроса |
| `rates.*` | формулировки оценки: строка цены и срока, названия элементов, допущения |
| `meta.*` | документация самого файла: область применения, доступные данные |

### 12.3 Что сознательно осталось в коде

- **Сообщения валидации конфигурации** (`validateConfig`, `validateProfile`): они нужны
  разработчику и завязаны на структуру конфига, а не на пользователя.
- Значения-перечисления (`VERDICT`, `RISK`, `STOP_REASONS`, `ANOMALY`) — это внутренние
  ключи; их человекочитаемые подписи лежат в `texts.json`.
- Комментарии и JSDoc, разумеется, остаются в коде.

Если нужно поменять формулировку, которой нет в `texts.json`, — вероятно, это диагностика
конфига; правьте её прямо в `load-config.js`, помня, что на неё опираются тесты.

### 12.4 Контракт текстов — `src/texts/contract.js`

`TEXT_CONTRACT.required` — список путей с ожидаемыми плейсхолдерами. Это живая спецификация:

- добавляете текст в код → добавляете путь в контракт;
- `test/texts.test.js` проверяет: все пути существуют, непусты, плейсхолдеры совпадают,
  списки и словари заполнены, «сиротских» ключей в `texts.json` нет;
- отдельный тест рендерит реальные сообщения, план, статус, профиль, dashboard и проверяет,
  что **в выводе не осталось незаполненных `{плейсхолдеров}`**.

### 12.5 Как поменять текст локально

```bash
cp config/texts.json config/local.texts.json     # имя подпадает под .gitignore
# оставить только нужные ключи, остальное возьмётся из базового файла
echo "TEXTS_FILE=config/local.texts.json" >> .env
node --test test/texts.test.js
```

---

## 12a. Уведомления о границах окна

Бот присылает в чат два сообщения в сутки: когда окно опроса **открывается** (05:00 МСК)
и когда **закрывается** (20:00 МСК). Тексты — `config/texts.json` → `window.opened.*` и
`window.closed.*`.

Как это устроено:

| Механизм | Где | Зачем |
|---|---|---|
| `trackWindowBoundary()` | `scheduler.js` | сравнивает текущее состояние окна с предыдущим и вызывает `onWindowChange` только на переходе |
| `windowOpen` в `state.json` | `scheduler.state` | после перезапуска бот не шлёт ложное «окно открылось» |
| `buildWindowNotifier()` | `index.js` | собирает текст и отправляет его через Telegram-клиент |
| `dailyCounters` в `state.json` | `index.js` | запросы и новые задания за текущий цикл — для статистики в сообщениях |

Содержимое сообщений:

- **открытие**: расписание (окно, пауза, часовой пояс), сколько заданий обработано за прошлый
  день, «первый запрос будет сделан сразу», напоминание про `/pause` и `/status`;
- **закрытие**: когда возобновятся запросы, за сегодня (запросов, новых заданий, всего в
  списке), что пока окно закрыто — запросов не будет.

Если chat id ещё неизвестен (никогда не запускали `bot` и не задали `TELEGRAM_CHAT_ID`),
уведомление не отправляется, а в лог пишется предупреждение `windowNotifyNoChat`.

Тесты: `test/scheduler.test.js` — «уведомление об открытии окна отправляется один раз на
переход», «уведомление о закрытии окна содержит время следующего открытия и статистику»,
«state содержит windowOpen».

## 12b. Оценка цены и срока

Оценка строится **от ставки пользователя**, а не из «средних по рынку».
Источники чисел — профиль:

```jsonc
"pricing": {
  "hourly_rate": 700,                       // ставка, ₽/час
  "rate_card": {
    "hours_per_content_section": 2.5,       // объёмная секция контента с адаптивом: 2–3 ч
    "minimum_hours": 2,                     // минимум по проекту
    "component_hours": {                    // часы за отдельные элементы сверх контента
      "calculator": 4, "sliders": 3, "beforeAfter": 3, "forms": 1.5, "mask": 0.5,
      "tabs": 1.5, "accordion": 1, "modal": 1.5, "gallery": 2, "map": 1,
      "animations": 2, "seo": 1.5, "customDesign": 4, "texts": 3, "images": 1.5,
      "pdf": 1, "stack": 0, "multipage": 0
    },
    "urMultiplyPerSection": 1.5             // множитель при срочности
  }
}
```

Алгоритм (`src/analysis/rate-estimator.js`):

1. **Объём** — `countContentSections`: явное число («5 секций»), пронумерованный список
   («1. Шапка», «2. Баннер»), список пунктов, слова-подсказки («лендинг», «одну секцию»),
   абзацы. Приоритет — у явного числа и списка, берётся максимум.
2. **Элементы** — `detectComponents`: калькулятор, слайдеры, «до/после», формы, маска,
   модальные окна, табы, аккордеон, галерея, карта, анимации, SEO, индивидуальный дизайн,
   тексты, изображения, PDF, несколько страниц.
3. **Часы** = секции × 2.5 (+ множитель срочности) + часы за элементы, не меньше минимума.
4. **Цена** = часы × ставка, диапазон 0.85–1.25 от расчётных часов, округление до 100 ₽.
5. **Срок** = часы / 6 (рабочий день), минимум 1 день; «1–1» не выводится.

Особые случаи:

| Ситуация | Поведение |
|---|---|
| в профиле нет `hourly_rate` | оценка **не выдумывается**, черновик пишет «Стоимость: назову после уточнения объёма» |
| объём не виден | оценка по минимальному объёму с пометкой «ориентир… точную цену подтвержу после просмотра макета» |
| срочность | часы секций умножаются на `urMultiplyPerSection`, в допущениях появляется предупреждение |
| оценка всегда | диапазон + список допущений; точная цифра — только после просмотра макета |

## 12c. Черновик отклика

Черновик (`src/analysis/proposal-draft.js`) повторяет структуру реальных откликов
пользователя:

```
Здравствуйте!

<подтверждение по материалам: «Макет посмотрел» / «Ознакомился с референсом» /
 «пришлите, пожалуйста, ссылку на макет»>
<готовность: «Готов разработать проект…»>

Что сделаю:
— <состав работ по тому, что перечислено в задании>;

Объём: 4 секции контента с адаптивом.

Отдельно реализую:
— формы заявок с валидацией;
— плавные анимации появления;

Стек: HTML, CSS, SCSS/SASS, JavaScript.

Без backend, интеграций с CMS и внешними API — это не входит в мою услугу.

Стоимость: 2800–4200 ₽ (около 4–6 ч по ставке 700 ₽/час). Срок: 1 день.

Уточните, пожалуйста:
1. Нужен ли мобильный вариант, или ориентируемся на представленные макеты?

Черновик для ручной проверки. На Kwork ничего не отправлено.
```

### Правило про «макет посмотрел»

Бот **не открывает страницы заданий** и не может открыть чужую ссылку. Поэтому утверждать
просмотр можно только тогда, когда это следует из текста карточки
(`src/analysis/job-signals.js`):

| Что в тексте задания | Что пишет бот |
|---|---|
| реальная ссылка (`https://www.figma.com/...`) или «ссылка прилагаю / доступ открыт» | «Макет посмотрел.» |
| ссылка на чужой сайт-образец, «пример», «референс» | «Ознакомился с референсом.» |
| «эскиз прикреплён», `.png`, `.pdf`, «во вложении» | «Материалы, приложенные к заданию, посмотрел.» |
| «ссылку вышлю по запросу» | «Готов выполнить — пришлите, пожалуйста, ссылку на макет.» |
| ничего из перечисленного | «По описанию задача понятна.» |

### Чего в черновике быть не может

`findInternalKeys()` (и тест `test/rates.test.js`) проверяют, что в тексте отклика нет
внутренних имён и значений проекта: `dedupKey`, `provenance`, `kworkCategoryId`,
`matchedBy`, названий стратегий парсера, `offersCount`, `hourly_rate`, `pendingNotifications`
и прочего. Только человеческие данные: состав работ, стек, цена, срок, вопросы.

Дополнительно в черновике не выводятся: ссылка на профиль заказчика, число просмотров
задания и `USERID` — они не нужны заказчику и являются лишними персональными данными.

### Как поменять стиль

| Что | Где |
|---|---|
| приветствие по тону | профиль `proposal_preferences.tone` + `texts.json` → `proposal.greetings.*` |
| фразы подтверждения и готовности | `texts.json` → `proposal.acknowledge.*`, `proposal.ready.*` |
| состав работ | `texts.json` → `proposal.scopeItems.*` |
| исключения | `texts.json` → `proposal.exclusions.*` |
| вопросы | `texts.json` → `proposal.materialsQuestions.*` |
| цена и срок | профиль `pricing.hourly_rate`, `pricing.rate_card` + `texts.json` → `rates.*` |

## 13. Безопасность и приватность

Аудит выполнен по проекту целиком; проверки закреплены в `test/security.test.js` (13 тестов),
поэтому регрессия по этим пунктам невозможна незаметно.

### 13.1 Сеть: что и куда уходит

| Куда | Метод | Когда | Заголовки |
|---|---|---|---|
| `kwork.ru` (`/projects` и категории) | **только GET** | окно 05:00–20:00 МСК, пауза 240–600 с | `user-agent`, `accept` — и всё |
| `api.telegram.org` | POST | отправка сообщения, приём команд | токен в URL, JSON-тело |
| `api.anthropic.com` / LLM-эндпоинт | POST | **только** если включён `MODEL_PROVIDER` | ключ из окружения |

Проверки:

- список хостов в `src/` ограничен явным белым списком (тест «сетевые адреса в коде
  ограничены известным списком»);
- POST вне Telegram и модели невозможен (тест «на Kwork нет ни одного POST»);
- запрос к Kwork не содержит `cookie`, `authorization`, `referer`, `origin`
  (тест «запросы к Kwork не содержат cookies, referer и авторизации»);
- источник отклоняет URL вне `allowedUrls` и их страниц `?page=N` **до** выхода в сеть.

### 13.2 Секреты

- читаются **только** из окружения/`.env`; в `config/*.json` их нет и быть не должно;
- `.env` и `data/` — в `.gitignore`; тест проверяет и содержимое репозитория, и наличие
  правил игнорирования;
- логи редактируются: токен Telegram, `sk-…`, `sk-ant-…`, `Bearer …`, `api_key=…`,
  `password=…` заменяются на `[redacted]`. Отдельный тест проверяет, что маркер из
  **хвоста** длинной строки (например, конца HTML-страницы) не попадает в лог — значение
  обрезается до 200 символов с пометкой «обрезано»;
- в systemd секреты не передаются через `Environment=` (см. `docs/DEPLOY-VPS.md`).

### 13.3 Данные: что хранится и что уходит в Telegram

| Данные | Где | Комментарий |
|---|---|---|
| Нормализованные поля заданий | `data/*.json*` | id, ссылка, заголовок, бюджет, категория, время |
| Имя заказчика и ссылка на профиль | в памяти + сообщение Telegram | по решению пользователя; в `seen-index.json` не пишется |
| `USERID` заказчика, аватар, служебные поля | **нигде** | парсер их не сохраняет |
| Текст HTML | нигде | разбирается в памяти, `rawHtmlStored: false` |
| Тексты сообщений (черновики) | `data/state.json` → `pendingNotifications` | только пока сообщение не доставлено |
| Логи циклов | journald | без имён заказчиков, без chat id, без HTML |

Тест «HTML не сохраняется ни в индекс, ни в журнал» проверяет, что в файлы не попали
`<html`, `<script`, `window.__INITIAL_STATE__`, `USERID`, `profilePictureSrcSet`.
Тест «личные идентификаторы не уходят в логи цикла» — что в логе нет `username` заказчиков.

### 13.4 Dashboard

- слушает `127.0.0.1` по умолчанию;
- **без аутентификации** и отдаёт состояние бота, заголовки заданий и последние записи;
- если запустить с `--host=0.0.0.0`, в лог пишется предупреждение
  (`logs.dashboardPublicWarning`) — не публикуйте порт, используйте SSH-туннель;
- страница только для чтения: изменить настройки через неё нельзя;
- содержимое экранируется (`escapeHtml`), включая данные профиля.

### 13.5 Инъекции и целостность сообщений

- все значения из задания экранируются перед вставкой в HTML-сообщение Telegram;
- количество `<b>` и `</b>` в каждой части совпадает (тест) — незакрытые теги не ломают
  `parse_mode=HTML`;
- сообщение не содержит токенов, `Bearer`, `cookie`, `authorization` (тест);
- подписи метрик сверяются с данными: `extra.offersCount` показывается как
  «предложений к заданию», `extra.kworkCount` — как «заказов у заказчика». Тест
  «подписи метрик соответствуют данным (предложения ≠ заказы)» ловит возврат старой ошибки.

### 13.6 Что осталось как риск и как его снижать

| Риск | Оценка | Что делать |
|---|---|---|
| Dashboard без пароля | средний | не выставлять наружу, только SSH-туннель |
| `.env` на сервере | средний | `chmod 600`, владелец `kwork`, не в git |
| Имя заказчика в сообщении Telegram | низкий | так задумано; можно убрать ключ `telegram.labels.client` (текст пустой → строка исчезнет) |
| Данные заданий в `state.json` | низкий | `chmod 700 data/`, бэкапы не публиковать |
| Остановка по CAPTCHA | низкий | снижать частоту и число URL, не обходить защиту |

---

## 14. Перенос на VPS

Полная пошаговая инструкция — **[docs/DEPLOY-VPS.md](DEPLOY-VPS.md)**: выбор сервера,
настройка SSH/UFW, установка Node.js, доставка кода, `.env`, проверки перед запуском,
systemd-юнит с ограничениями прав, логи и мониторинг, обновление и откат, бэкапы,
безопасность сервера, частые проблемы, чек-лист переноса.

Короткая версия:

```bash
# на сервере (Ubuntu 22.04+), под пользователем kwork
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
git clone <репозиторий> /opt/kwork-watcher/app && cd /opt/kwork-watcher/app
cp .env.example .env && chmod 600 .env && nano .env     # токен и user id
node --test && node src/index.js config-check --live
node src/index.js poll                                 # проверка вручную
# затем systemd-юнит из docs/DEPLOY-VPS.md → раздел 8
sudo systemctl enable --now kwork-bot
```

Ключевые отличия серверного запуска от локального:

1. **Один владелец токена.** Нельзя одновременно опрашивать Telegram из двух мест —
   будет `Conflict: terminated by other getUpdates request`.
2. **`poll` требует известного chat id.** Либо один раз запустить `bot` и отправить `/start`,
   либо задать `TELEGRAM_CHAT_ID`.
3. **Рабочий каталог важен.** `.env`, `config/` и `data/` читаются относительно
   `process.cwd()`; в systemd это задаётся `WorkingDirectory`.
4. **Часовой пояс сервера не важен** — окно считается в `Europe/Moscow` через `Intl`.
5. **`systemctl restart` безопасен**: бот по `SIGTERM` сохраняет offset и состояние, а после
   старта выдерживает минимальный интервал с момента последнего запроса.

---

## 15. Рецепты модификаций

### 15.1 Поменять формулировки (без правки кода)

```bash
cp config/texts.json config/local.texts.json
# правим нужные ключи, например telegram.sections.draft
echo "TEXTS_FILE=config/local.texts.json" >> .env
node --test test/texts.test.js
```

### 15.2 Добавить новую строку в сообщение

1. `config/texts.json` → `telegram.labels.myField: "Моя метка"`.
2. `src/texts/contract.js` → добавить `{ path: 'telegram.labels.myField' }` (и `placeholders`,
   если есть `{...}`).
3. `src/telegram/format.js` → `facts.push(label(t('telegram.labels.myField'), значение))`
   (не забудьте `escapeHtml` для значений из задания).
4. `node --test test/texts.test.js test/analyzer.test.js` — тесты контракта и сообщения.

### 15.3 Изменить черновик отклика

- структура и порядок блоков — `src/analysis/proposal-draft.js`;
- сами фразы — `config/texts.json` → `proposal.*`;
- тон и обязательные пункты — `config/performer-profile.json` → `proposal_preferences`
  (`tone`, `must_mention`, `must_avoid`, `questions_before_quote`).

### 15.3a Изменить ставку или нормы времени

```jsonc
// config/performer-profile.json
"pricing": {
  "hourly_rate": 900,                     // новая ставка
  "rate_card": {
    "hours_per_content_section": 2,        // если секции даются быстрее
    "component_hours": { "calculator": 3 } // точечная правка по элементу
  }
}
```

Проверка: `node --test test/rates.test.js`, затем `node src/index.js dry-run` — увидите
новые цифры в черновиках. Если убрать `hourly_rate`, бот перестанет называть цену и будет
писать «назову после уточнения объёма».

### 15.3b Изменить уведомления о границах окна

Тексты — `config/texts.json` → `window.opened.*` и `window.closed.*`. Если уведомления не
нужны совсем, задайте в локальном файле текстов пустые строки — тогда отправляется пустое
сообщение; надёжнее отключить сам обработчик, убрав `onWindowChange` при создании
планировщика в `src/index.js`.

### 15.4 Настроить расписание и глубину

```jsonc
"schedule": { "windowStart": "09:00", "windowEnd": "20:00",
              "minIntervalSeconds": 300, "maxIntervalSeconds": 600 },
"source":   { "pagination": { "enabled": true, "maxPagesPerUrl": 5 } }
```

Помните: `minIntervalSeconds ≥ 240` и `maxIntervalSeconds ≤ 600` — иначе `validateConfig`
заблокирует запуск. Множитель запросов: `число URL × maxPagesPerUrl` за цикл.

### 15.5 Добавить категорию и связать с Kwork

1. `config/default.json` → `targetCategories`: `id`, `label`, `priority`, `matchHint`,
   `kworkCategoryId` (если известен).
2. `node src/index.js categories` → посмотреть, какие `category_id` встречаются.
3. `categoryMapping.byCategoryId` → `{ "<id Kwork>": "<ваш id>" }`, затем
   `"confirmed": true`.
4. `node --test test/embedded-json.test.js test/cycle.test.js`.

### 15.6 Парсить новое поле из выдачи Kwork

1. Найти поле в `wants` (живой HTML или фикстура).
2. `src/parser/embedded-json-parser.js` → `jobFromWant`: добавить поле как есть,
   при отсутствии — в `missingFields`.
3. Даты — через `parseEmbeddedDate`, деньги — через `buildEmbeddedBudget`.
4. Показать в сообщении (см. 15.2).
5. Тест в `test/embedded-json.test.js` с полем и без него.

### 15.7 Включить LLM

```ini
MODEL_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=...
LLM_MODEL=deepseek-chat
```

Модель может дополнить только `summary`, `notes`, `extraQuestions`. Промпт и логи адаптера —
в `texts.json` → `model.*`. При любой ошибке анализ продолжается на эвристике.

### 15.6a Изменить структуру профиля

1. `config/performer-profile.json` — эталон: по нему выдаётся шаблон (`/profile template`).
2. Поля читают: `analysis/analyzer.js` (skills, keywords, pricing, availability),
   `analysis/rate-estimator.js` (pricing, rate_card), `analysis/proposal-draft.js`
   (proposal_preferences, portfolio, services).
3. `validateProfile` в `config/load-config.js` — предупреждения о неполном профиле.
4. `isUsable` в `storage/profile-store.js` — что считать пригодным для анализа.
5. `node --test test/profiles.test.js test/profile-upload.test.js`.

Личные профили пользователей менять не нужно: они подхватят новую структуру при следующей
загрузке (старые поля остаются работать, пока код их читает).

### 15.7a Подключить нового пользователя

1. Пользователь пишет боту `/start`.
2. Владельцу приходит уведомление с его id; посмотреть список: `/users`.
3. Подтвердить: `/approve <id>`; отклонить: `/deny <id>`.
4. Ничего перезапускать не нужно — доступ сохраняется в `data/telegram-state.json` сразу.

Если нужно, чтобы доступ выдавался автоматически: `config/default.json` →
`"telegram": { "autoApprove": true }` и перезапуск `bot`.

### 15.7b Изменить меню команд Telegram

1. `config/texts.json` → `commands.telegramMenu`: пары `[команда, описание]`.
2. Ограничить набор: `config/default.json` → `"telegram": { "menuFilter": ["start", "status"] }`.
3. Перезапустить `bot` — при старте вызывается `setMyCommands`.
4. `node --test test/telegram-users.test.js test/texts.test.js`.

Описания должны быть в нижнем регистре и не длиннее 256 символов — тест это проверяет.

### 15.8 Подменить канал доставки

Реализуйте объект с `sendMessage(text, { parseMode })` и передайте как `notifier`
в `createCycleRunner`. Образец — `NullNotifier` в `src/telegram/client.js`.

### 15.8a Обновить или расширить категории

1. **Обновить каталог с сайта:** `node src/index.js categories-refresh`
   (или `--file=page.html` без сети). Данные берутся из inline-JSON страницы списка.
2. **Включить категорию в набор по умолчанию:** `config/default.json` → `targetCategories`
   (`kworkCategoryId` + `label` + `subsection`) и `categoryMapping.byCategoryId`.
3. **Дать пользователям выбрать:** ничего делать не нужно — они укажут id или название
   командой `/categories`. Правки кода не требуются.
4. **Проверить:** `node src/index.js categories-refresh`, затем
   `node --test test/category-catalog.test.js test/categories.test.js`.

Если каталог не обновляется (сайт поменял разметку), проверьте, что в HTML страницы есть
ключ `categoriesWithFavoritesList` или `categories`.

### 15.9 Подключить ИИ-модель

1. Получить ключ у провайдера (см. [docs/MODEL-SETUP.md](MODEL-SETUP.md)).
2. Записать в `.env`: `MODEL_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_API_KEY`,
   `LLM_MODEL`. В `LLM_BASE_URL` — база **без** `/chat/completions`.
3. Задать бюджет: `config/default.json` → `model.usage.perDay` / `perHour` под лимиты тарифа.
4. `node src/index.js config-check --live`, затем `node src/index.js bot`.
5. Смотреть в логе `method` (должен быть `openai-compatible`) и предупреждения модели.

### 15.10 Добавить проверку в тесты безопасности

`test/security.test.js` — место для правил вида «X не должен попадать в лог/сообщение/файл».
Добавляйте тест сразу, как только появляется новый класс данных.

---

## 16. Границы проекта

**Разрешено (подтверждено пользователем):** одиночные GET страниц списка заданий
`https://kwork.ru/projects` и его категорий `?c=79`, `?c=38`, `?c=37`, включая их страницы
`?page=N`, со случайной паузой 4–10 минут в окне 05:00–19:00 МСК.

**Запрещено и не реализовано намеренно:**

| Запрет | Где закреплён |
|---|---|
| Страницы отдельных заданий | `validateSourceUrl` (путь ≠ `/projects` → ошибка) |
| API, поиск, профили, аккаунтные разделы | там же |
| Авторизация, cookies, токены, обход защиты, прокси, смена отпечатка | `fetchSinglePage` (нет заголовков), отсутствие кода |
| Отклики, сообщения, заявки, любые изменения на Kwork | в проекте нет ни одного POST на Kwork |
| Хранение HTML | `rawHtmlRetention: discard`, `rawHtmlStored: false` |
| Ускорение при ошибках | `HARD_STOP_REASONS`, счётчики ошибок |
| Включение платной модели без настройки | `model.provider: heuristic` по умолчанию |

**Если нужно расширить объём доступа** — это не техническая, а договорная правка: сначала
подтверждение, затем `source.permission.scope` + `scopeChanges` в конфиге, затем код.

---

## 18. Подключение бота и доступ пользователей

Бот не привязан к одному человеку. Владелец задаётся в `.env`, остальные подключаются сами.

### 18.1 Роли

| Роль | Как появляется | Что может |
|---|---|---|
| **владелец** | `TELEGRAM_ALLOWED_USER_ID` в `.env` | всё + `/users`, `/usage` |
| **пользователь** | написал `/start` — доступ открывается сразу | команды, свой профиль, свои категории |

Подтверждения владельцем нет: новое подключение только пишется в лог
(`Новый пользователь подключился к боту`). Закрыть доступ можно через
`config.telegram.autoApprove = false` — тогда сообщения незнакомцев игнорируются.

### 18.2 Поток подключения

```
человек → /start
   ↓  client.pollOnce: не в approvedUsers → markNewUser + approveUser + save
   ↓  в лог: «Новый пользователь подключился к боту» {userId, username, name}
   ↓  сообщение помечается isNewUser: бот обновляет список получателей
   ↓  ответ: приветствие и два шага — /profile upload, /categories
человек → /status, /plan, /profile, /categories, /pause, /resume
```

`seenUsers` хранит тех, кто уже подключался: по нему `markNewUser` отличает первое
подключение от повторного (и не дублирует лог).

### 18.3 Хранение: `data/telegram-state.json`

```jsonc
{
  "offset": 12345,                 // getUpdates offset: старые команды не перечитываются
  "chatId": 442109035,             // основной чат для уведомлений
  "ownerId": 442109035,            // владелец (из .env или первый написавший)
  "approvedUsers": [442109035, 77777777],
  "seenUsers": [442109035, 77777777],   // кто уже подключался (для лога «новый»)
  "knownUsers": {
    "88888888": { "id": 88888888, "chatId": 88888888, "username": "client", "name": "Иван", "addedAt": "…" }
  },
  "updatedAt": "…"
}
```

`knownUsers` хранит только публичные данные Telegram (id, username, имя) — это нужно, чтобы
после `/approve` бот знал, куда отправить уведомление. Токенов в файле нет.

Совместимость: старый файл с одним `chatId` читается как один подтверждённый пользователь.

### 18.4 Команды

| Команда | Кто может | Что делает |
|---|---|---|
| `/start` | любой | регистрация: доступ открывается сразу, приходит приветствие |
| `/status`, `/plan`, `/profile`, `/categories`, `/pause`, `/resume`, `/help` | все | обычные команды |
| `/users` | **только владелец** | владелец и список подключённых |
| `/usage` | **только владелец** | расход приложения: пользователи, циклы, модель, токены |

Тексты — `config/texts.json` → `commands.onboarding.*`.

**Как закрыты команды владельца.** Telegram не умеет права доступа, поэтому защита двойная:

1. **В меню:** публикуются два набора — `commands.telegramMenu` (без области видимости,
   видят все) и `commands.telegramMenuOwner` (со `scope: {type:'chat', chat_id:<владелец>}`).
   Так `/users` и `/usage` видны только в чате владельца.
2. **В коде:** `dispatchCommand` содержит `OWNER_ONLY = {users, usage}` и отвечает
   `commands.onboarding.ownerOnly` всем, кроме владельца.

**Важно про разметку ответов.** Ответы команд уходят с `parse_mode=HTML`, поэтому символы
`<` и `>` в текстах недопустимы, кроме известных тегов Telegram. Именно на этом падала
команда `/users`: в подсказке было `/approve <id>`, и Telegram отвечал
`can't parse entities: Unsupported start tag "id"`. Теперь подсказка содержит числовой
пример, а тест `test/telegram-commands.test.js` проверяет каждый ответ на команду
валидатором `validateTelegramHtml` (пары тегов, только разрешённые теги, нет `<` вне тегов).

### 18.5 Меню команд Telegram

При старте режима `bot` вызывается `setMyCommands`, поэтому команды видны в интерфейсе
(кнопка меню). Список и описания — **только** в `config/texts.json`:

```jsonc
"commands": {
  "telegramMenu": [["start", "запустить бота и получить доступ"], ["status", "…"]]
}
```

Ограничить публикуемый набор — `config.telegram.menuFilter` (пустой массив = все команды).
Требования Telegram: имя команды в нижнем регистре, описание ≤ 256 символов — проверяются
тестом. Ошибка публикации не критична: бот пишет предупреждение `telegramCommandsFailed`
и продолжает работать (команды просто не появляются в меню).

### 18.6 Автодоступ

`config/default.json` → `"telegram": { "autoApprove": true }` выдаёт доступ сразу при
`/start`. Подходит для доверенного окружения (несколько своих устройств, семья, команда).
По умолчанию `false`: каждый новый пользователь требует решения владельца.

---

## 18a. Профиль у каждого пользователя

Профиль определяет вердикт, риски, цену, срок и черновик отклика. Поэтому он **личный**:
один общий профиль на всех не имеет смысла, если ботом пользуются разные люди.

### 18a.1 Приоритет профилей

```
1. data/profiles/<userId>.json     личный профиль (загружен через /profile upload)
2. config/performer-profile.json   общий профиль из PROFILE_FILE (запасной)
3. нет профиля                      задания не отправляются, раз в сутки напоминание
```

Реализация — `src/storage/profile-store.js` (`ProfileStore`):

| Метод | Назначение |
|---|---|
| `get(userId)` | `{ profile, source: 'personal'|'fallback'|null, path }` |
| `parse(text)` | проверка загруженного текста: JSON, размер, содержательность |
| `import(userId, text)` | проверка + атомарное сохранение |
| `save` / `remove` / `has` | работа с личным файлом |
| `noteReminder(userId)` | напоминание не чаще раза в сутки |
| `summarize(userIds)` / `listPersonal()` | кто с профилем и кто без |

Профиль считается пригодным (`isUsable`), если есть хотя бы одно из: `skills`, `portfolio`,
`services`, `pricing.minimum_project_price`/`hourly_rate`, `matching_preferences.positive_keywords`.
Пустой объект формально валиден, но анализировать по нему нечего — такой файл отклоняется.

### 18a.2 Загрузка профиля файлом

```
/profile            показать профиль и источник
/profile upload     включить ожидание файла (5 минут) и попросить прислать JSON
/profile template   получить шаблон профиля документом
/profile reset      удалить личный профиль, вернуться на общий
```

Порядок обработки файла (`KworkWatcherBot.handleProfileDocument`):

1. файл принимается **только** если пользователь вызвал `/profile upload` — случайный
   документ в чате игнорируется (окно ожидания хранится в памяти, `pendingProfileUploads`);
2. `client.downloadFile(fileId)` — `getFile` + загрузка по `file_path`, лимит 256 КБ;
3. `profiles.import()` — разбор, проверка размера, валидация, проверка содержательности;
4. при успехе — сохранение в `data/profiles/<id>.json` и ответ «Профиль сохранён»;
5. при ошибке — понятная причина («не корректный JSON», «больше 256 КБ», «нет ни skills,
   ни portfolio, ни pricing»), **прежний профиль не затрагивается**.

Ошибка скачивания не роняет бота: пользователю уходит сообщение с причиной, в лог — запись
`logs.profileUploadRejected`.

### 18a.3 Анализ на каждого получателя

Цикл (`src/scheduler/cycle.js`) больше не анализирует задание один раз:

```
новые задания (нет в seen-index)
   ↓ для каждого получателя (подтверждённые пользователи + их чаты)
      есть профиль?
        нет → в summary.noProfile, напоминание (не чаще раза в сутки)
        да  → analyzeAndDraft(job, профиль) → renderJobMessages → sendMessage(chatId)
   ↓ задание пишется в seen-index только после успешной доставки хотя бы одному
```

Важные следствия:

- вердикт, цена, срок и черновик **разные** у разных пользователей (цена считается от их ставки);
- расход модели растёт пропорционально числу получателей — бюджет (`model.usage`) общий на процесс;
- список получателей динамический: `recipients` — функция, читающая
  `state.telegram.recipients`; бот обновляет его при изменении доступа (`syncRecipients`);
- без `recipients` работает прежняя схема: один профиль и `notifier.chatId`.

### 18a.4 Где хранится

| Файл | Что внутри |
|---|---|
| `data/profiles/<id>.json` | личный профиль пользователя |
| `data/profiles/reminders.json` | когда кому последний раз напоминали о профиле |

Оба файла попадают в git-игнор вместе с `data/` и в бэкап (см. `docs/DEPLOY-VPS.md`).

## 18b. Категории у каждого пользователя

Задания различаются полем `category_id` из выдачи — это целое число, совпадающее с
параметром `?c=` в адресе категории на Kwork. Один `category_id` покрывает подраздел целиком
(например, 37 — и «Верстка по макету», и «Доработка и адаптация верстки»), разделить их
по числовому id нельзя.

**Приоритет выбора:**

```
1. data/categories/<userId>.json   личный выбор пользователя
2. config.default.json             targetCategories — значения по умолчанию
```

**Команда `/categories`** (доступна всем подтверждённым):

| Ввод | Действие |
|---|---|
| `/categories` | показать текущий выбор и его источник |
| `/categories list` | каталог известных категорий с названиями |
| `/categories 37,38,79` | выбрать конкретные категории |
| `/categories all` | любые категории, фильтр выключен |
| `/categories reset` | вернуться к категориям по умолчанию |

Реализация — `src/storage/category-store.js`:

| Функция | Назначение |
|---|---|
| `createCategoryCatalog(config)` | id → название из `config.categoryCatalog.entries` |
| `CategoryPreferences.effective(userId)` | `{ selection, source: 'personal'\|'default' }` |
| `CategoryPreferences.matches(userId, job)` | подходит ли задание пользователю |
| `parseCategoryIds(args)` | разбор «37,38 79» → `[37, 38, 79]` |
| `normalizeSelection(selection)` | канонизация: `'all'` или отсортированный массив id |

**Ловушка, которую важно помнить:** `Number(null)` равно `0`, а `Number.isFinite(0)` — `true`.
Если приводить `job.kworkCategoryId` к числу до проверки на пустоту, задание без категории
получит «кандидата 0» и будет молча отброшено. Поэтому исходные значения проверяются
на `null`/`undefined`/`''` до `Number()`.

**Фильтрация идёт до анализа** (в цикле, перед `analyzeAndDraft`): задание из чужой категории
не тратит вычисления, квоту модели и место в индексе. Счётчик `summary.skippedByCategory`
попадает в метрики.

### Каталог категорий: полный список сайта

Полный справочник лежит в **`config/categories.json`** и генерируется из страницы списка
заданий: в её inline-JSON есть объект `categoriesWithFavoritesList` с деревом категорий.

| Что внутри | Значение |
|---|---|
| Разделы | 7 (`Тексты и переводы`, `Аудио, видео, съемка`, `Разработка и IT`, `Дизайн`, `SEO и трафик`, `Соцсети и маркетинг`, `Бизнес и жизнь`) |
| Категории | 54 |
| Подразделы (атрибуты) | 219 |

Связь с запросами:

| Сущность | Запрос | Пример |
|---|---|---|
| Категория | `/projects?c=<id>` | `/projects?c=79` — «Верстка» |
| Подраздел | `/projects?c=<id>&attr=<id>` | `/projects?c=79&attr=224` — «Верстка по макету» |

Числовой `id` совпадает с полем `category_id` в выдаче заданий — поэтому по каталогу
показывается название вместо числа (`applyCategoryName` подставляет его в
`declaredCategory` и `category.label` перед отправкой сообщения).

**Обновление каталога:**

```bash
node src/index.js categories-refresh                 # один GET на разрешённый URL списка
node src/index.js categories-refresh --file=page.html # из сохранённой страницы (без сети)
```

Разбор: `parseCategoryCatalog(html)` в `src/storage/category-catalog.js`. Дерево достаётся
из inline-JSON функцией `sliceJsonObject` (балансировка скобок и строк) — регуляркой такое
не разобрать, внутри строк встречаются и скобки, и кавычки.

**Поиск по названию** (`searchCatalog`, общий для файла каталога и каталога приложения):

| Приём | Что снимает |
|---|---|
| `toLowerCase()` | регистр |
| `ё → е` | «вёрстка» = «верстка» |
| `й → и` | «сайта» = «саита», «таймлайн» = «таимлаин» |
| Дефисы, кавычки, лишние пробелы | «Сайт-визитка», ««Мокап»» |
| Совпадение по целым словам | «по» не находится внутри «наполнение», «ии» — внутри «ИИ-генерация» |
| Поиск по основе (≥4 символов) | «саита» находит «Сайта» |

Порядок разбора пользовательского ввода (`resolveCategoryInput`):

1. **вся фраза целиком** — «Вёрстка по макету» приходит четырьмя аргументами и должно
   распознаться как подраздел;
2. точное название категории;
3. точное название подраздела → категория + атрибут;
4. ровно одна категория по фразе;
5. **точное название раздела** → все его категории («Дизайн» → 11 категорий);
6. иначе — разбор по частям (числа, названия через запятую), неизвестное сообщается.

Формат ответа поиска единый: `{ categories, attributes, sections, exact, ambiguous }`.

### Факт с сайта: категории 37 и 79

Проверено по каталогу и живой выдаче:

| id | Название на сайте | Подразделы |
|---|---|---|
| 37 | **Создание сайта** | Новый сайт (`attr=5016`), Копия сайта (`attr=5017`) |
| 79 | **Верстка** | Верстка по макету (`attr=224`), Доработка и адаптация верстки (`attr=226`) |
| 38 | Доработка и настройка сайта | Доработка сайта (`attr=1271`) и ещё 5 |

Раньше в `targetCategories` названия были перепутаны (37 значилось как «Вёрстка»). Исправлено;
ссылки в `allowedUrls` не менялись — `?c=37/38/79` работают как прежде.

**Важно:** один числовой id покрывает несколько подразделов, поэтому по `category_id`
нельзя различить «Верстка по макету» и «Доработка и адаптация верстки». Различить их можно
только по `?c=79&attr=224` и `?c=79&attr=226`. Сейчас бот опрашивает категорию целиком
и перечисляет подразделы в сообщении.

**Краткая выжимка** (`config.categoryCatalog.entries`) осталась для совместимости: она
дополняет каталог и помечает категории «по умолчанию» (`inDefault`). Любой id вне каталога
принимается и помечается как «своя категория N».

## 18c. Защита загружаемого файла

Загрузка профиля — единственная точка, где в приложение попадают данные от других людей.
Проверки живут в `src/storage/profile-guard.js` и вызываются из `ProfileStore.parse`.

**Порядок проверок (от дешёвых к дорогим):**

1. **Тип файла** (`checkFileType`): расширение из `ALLOWED_FILE_EXTENSIONS` (`.json`, `.txt`)
   и MIME из `ALLOWED_MIME_TYPES`. Архивы, скрипты и страницы отклоняются отдельным правилом.
2. **Предварительный разбор** (`preflightJson`) — выполняется **до** `JSON.parse`:
   - размер ≤ 256 КБ, файл не пуст;
   - отсутствие управляющих символов (`\u0000`–`\u001f` вне строк);
   - глубина вложенности ≤ 64: считаем скобки вручную, не разбирая JSON. Это защита от
     переполнения стека на файле вида `[[[[…]]]]`;
   - баланс `{}`/`[]` с учётом строк и экранирования.
3. **JSON.parse** — не исполняет код, но результат всё равно проверяется.
4. **Схема** (`checkProfileShape`):
   - запрещённые ключи `__proto__`, `constructor`, `prototype` на любой глубине;
   - лимиты: глубина ≤ 8, ключей ≤ 200, строки ≤ 4000 символов, массивы ≤ 200 элементов,
     портфолио ≤ 50 работ, навыков и ключевых слов ≤ 100;
   - типы полей и числовые границы: цена ≥ 0 и ≤ 100 000 000, часов в неделю ≤ 168,
     срок ≤ 365 дней, `hours_per_content_section` ≤ 1000;
   - `categoriesSelection` — `'all'` или массив положительных id;
   - разметка: `<script>`, `<iframe>`, `javascript:`-ссылки отклоняются.
     Важно: проверка не должна ловить обычный навык «Базовый JavaScript: меню, табы» —
     поэтому `javascript:` проверяется только вместе с символом после двоеточия.
5. **Валидация профиля** (`validateProfile`) — предупреждения о неполном профиле.
6. **Содержательность** (`isUsable`) — нужен хотя бы один из блоков: `skills`, `portfolio`,
   `services`, `pricing`, `positive_keywords`.
7. **Частота** (`checkUploadRate`) — не больше 5 попыток за 10 минут на пользователя.
   Часы внедряются в конструктор бота (`now`), поэтому проверка детерминированна в тестах.

**Что даёт такая схема:** опасный файл отклоняется с понятной причиной и **не затирает
прежний профиль**; ни один ключ из файла не может повлиять на прототипы объектов приложения.

## 18d. Использование приложения (/usage)

Команда владельца `/usage` (в `OWNER_ONLY`) собирает картину по всему приложению.
Реализация — `buildUsageMessage` в `src/bot/kwork-watcher-bot.js`.

| Блок | Источник |
|---|---|
| Пользователи | `telegram-state.json`: `approvedUsers`, `pendingUsers`, `ownerId` |
| Профили и категории | `ProfileStore.summarize`, наличие файла в `data/categories/` |
| Задания | `store.stats.total` |
| Циклы и запросы | `state.json` → `metrics` |
| Модель и токены | `modelAdapter.usage` (`ModelUsageTracker`) |

**Метрики** (`state.json` → `metrics`) накапливает цикл: `cycles`, `requests`, `pages`,
`cards`, `newJobs`, `duplicates`, `sentMessages`, `pruned`, `errors`, `warnings`, `reminders`,
`skippedByCategory`, `firstRunAt`, `lastRunAt`.

**Токены** (`data/model-usage.json`):

| Поле | Смысл |
|---|---|
| `tokensIn` / `tokensOut` | за текущие сутки (сбрасываются при смене дня) |
| `totalTokensIn` / `totalTokensOut` | за всё время |
| `totalCalls` | сколько вызовов модели сделано всего |

Адаптер берёт расход из ответа провайдера: `usage.prompt_tokens` и `usage.completion_tokens`
у OpenAI-совместимых, `usage.input_tokens` и `usage.output_tokens` у Anthropic. Если провайдер
расхода не сообщает, бот пишет «провайдер не сообщает расход — считаем запросы».

## 18e. План опроса: URL по выбранным категориям

Какие URL опрашивать — зависит от выбора категорий (`src/source/poll-plan.js`):

| Выбор | Режим | Запросы |
|---|---|---|
| **не выбрано (по умолчанию)** | `all` | один на `/projects` — все задания |
| `/categories all` | `all` | то же |
| выбраны категории | `categories` | по одному на каждую: `/projects?c=<id>` |
| выбранное не объявлено в доступе | `declared` | объявленные URL, чтобы не остаться без заданий |

**Правило безопасности:** в план попадают только URL из `source.allowedUrls`. Всё остальное
отбрасывается и показывается в `/plan` как `не объявлен в source.allowedUrls`. Так выбранные
категории не могут расширить согласованный объём доступа.

Реализация:

| Функция | Назначение |
|---|---|
| `buildPollPlan({base, allowedUrls, selection})` | строит список URL и режим |
| `effectiveCategorySelection(selections)` | объединяет выбор нескольких получателей |
| `categoryIdOfUrl(url)` | категория из `?c=` (учитывает, что `Number(null) === 0`) |
| `baseFromAllowedUrls(allowedUrls)` | origin для построения URL |

Цикл получает план через `planUrlsForPass()`: читает выбор каждого получателя, объединяет,
строит план и ходит **только по нему**. В `summary.pollPlan` попадает режим и список URL.

**Важно:** план переносит в записи поля `pages` и `pagination` из объявленного URL. Без этого
глубина пагинации схлопывалась до одной страницы — регрессия, которую поймал тест
«план сохраняет глубину пагинации».

`/plan` и `node src/index.js plan` показывают актуальный план: для `/plan` берётся выбор
категорий того, кто спросил.

## 19. Модель анализа

### 19.1 Что работает по умолчанию: эвристика

`model.provider: "heuristic"` — **никакой нейросети**. Анализ целиком локальный:

| Шаг | Модуль | Что делает |
|---|---|---|
| Разбор карточки | `parser/embedded-json-parser.js` | достаёт `wants` из inline-JSON страницы |
| Соответствие профилю | `analysis/analyzer.js` | совпадения по `skills`, `positive_keywords`, `negative_keywords`, `excluded_work` |
| Риски | `analysis/analyzer.js` | `excluded_work`, `backend_requested`, `budget_below_minimum`, `unrealistic_deadline`, `vague_scope`, `unconfirmed_category` |
| Вердикт | `analysis/analyzer.js` | «подходит» / «возможно» / «не подходит» / «нужно уточнить» |
| Оценка денег и срока | `analysis/rate-estimator.js` | часы по `pricing.rate_card` × `pricing.hourly_rate` |
| Черновик отклика | `analysis/proposal-draft.js` | структура из `proposal.*`, данные из профиля |

Внешних вызовов нет вообще: тест «анализ с эвристикой не делает сетевых вызовов и помечает
провайдера» это фиксирует. Ничего не выдумывается: каждое утверждение помечено источником —
факт из задания, вывод приложения или «неизвестно».

### 19.1a Выбор бесплатного провайдера

Практическое руководство с конкретными настройками — **[docs/MODEL-SETUP.md](MODEL-SETUP.md)**.
Короткая версия:

| Вариант | Ключ и карта | Плюсы | Минусы |
|---|---|---|---|
| Google Gemini (`generativelanguage.googleapis.com/v1beta/openai`) | бесплатно, без карты | лучший русский, официальная OpenAI-совместимость | из РФ обычно нужен VPN |
| Groq (`api.groq.com/openai/v1`) | бесплатно, без карты | очень быстрый | русский слабее |
| OpenRouter (`openrouter.ai/api/v1`, модели `:free`) | бесплатно, без карты | работает из большего числа регионов | жёсткие суточные лимиты |
| Ollama (`127.0.0.1:11434/v1`) | ключ не нужен | нет лимитов и утечек | нужны ресурсы машины |

### 19.1b Бюджет запросов и выборочный вызов

Бесплатные тарифы ограничены по запросам в сутки и в час, поэтому в приложении есть
собственный учёт (`src/analysis/model-usage.js`, файл `data/model-usage.json`):

- `model.usage.perDay` / `perHour` — бюджет; `null` отключает ограничение;
- при исчерпании вызов не делается, анализ идёт на эвристике, в лог пишется
  `model.logBudgetDay` / `model.logBudgetHour`;
- сутки и час считаются в `schedule.timezone` (ваш рабочий пояс), счётчик переживает перезапуск;
- `model.selective.mode` — `uncertain` вызывает модель только когда эвристика не уверена
  (вердикт «возможно»/«нужно уточнить», есть риски или неизвестные поля), `always` — всегда.

Расход виден в `/status` и через `modelAdapter.usage`.

### 19.2 Что делает нейросеть, если её включить

Нейросеть — **надстройка**, а не замена. Провайдеры:

| `MODEL_PROVIDER` | Что нужно | Когда выбирать |
|---|---|---|
| `heuristic` (по умолчанию) | ничего | всё устраивает, нет желания платить и отдавать данные наружу |
| `openai-compatible` | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | DeepSeek, OpenRouter, локальный сервер с совместимым API |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Claude |

Модель может дополнить **только три поля**: `summary`, `notes`, `extraQuestions`. Вердикт,
риски, цена и срок остаются за эвристикой — то есть ответ модели не может «переписать»
оценку или придумать цифры. В сообщении это видно по строке источника выводов:
«выводы приложения (эвристика)» или «выводы приложения + модель <provider>».

Промпт (`model.prompt`), системная строка (`model.systemPrompt`) и логи адаптера живут в
`config/texts.json`, то есть меняются без правки кода.

Ошибки провайдера различаются (`classifyProviderStatus`) и дают разные подсказки:

| Ответ | Вид | Сообщение в логе | Что делать |
|---|---|---|---|
| 429 / `quota exceeded` | `rate-limit` | `model.logRateLimited` | уменьшить бюджет или частоту |
| 401 / 403 | `auth` | `model.logAuthFailed` | проверить `LLM_API_KEY` |
| 404 про модель | `model-not-found` | `model.logModelNotFound` | проверить `LLM_MODEL` |
| 400 про контекст | `too-long` | `model.logTooLong` | сократить описание |
| 5xx, таймаут | `provider-error` / `timeout` | `model.logCallFailed` | подождать, увеличить таймаут |

Неудачный запрос **не** списывается из бюджета: квота тратится только при успешном ответе.
Любая ошибка не мешает работе — задание всё равно анализируется и уходит в Telegram.

### 19.3 Что уходит наружу при включённой модели

В промпт попадают: заголовок задания, описание, бюджет, категория, результаты эвристики и
**выбранные поля профиля** (headline, skills, excluded_work, pricing, availability).
Не уходят: токен Telegram, chat id, ссылка на профиль заказчика, HTML страницы, `USERID`.
Учитывайте это, если включите внешнего провайдера: описание задания — публичный текст
заказчика, но профиль ваш.

### 19.4 Откуда берутся цифры в отклике

Никаких «средних по рынку». Только ваши собственные нормативы:

```jsonc
"pricing": {
  "hourly_rate": 700,
  "rate_card": {
    "hours_per_content_section": 2.5,   // объёмная секция контента с адаптивом
    "minimum_hours": 2,
    "component_hours": { "calculator": 4, "forms": 1.5, "animations": 2, … },
    "urMultiplyPerSection": 1.5         // при срочности
  }
}
```

Нет `hourly_rate` — бот не называет цену вообще. Это защита от выдуманных чисел, а не
недоделка: заполните ставку, и оценка появится.

---

## 20. Глоссарий

| Термин | Значение |
|---|---|
| **wants** | массив заданий во встроенном JSON страницы Kwork — источник данных |
| **карточка** | контейнер задания в HTML (для DOM-стратегий) |
| **задание (job)** | нормализованный объект после парсинга |
| **wants-элемент** | один объект массива `wants` до нормализации |
| **вердикт** | `подходит` / `возможно` / `не подходит` / `нужно уточнить` |
| **предварительный** | в профиле не хватает полей → уверенная оценка невозможна |
| **fact / inference / unknown** | факт из карточки / вывод бота / неизвестное |
| **dedupKey** | ключ дедупликации: `id:<id>`, `url:<ссылка>` или `composite:<хеш>` |
| **probableMatch** | совпадение по составному ключу — возможен ложный дубликат |
| **prune** | удаление из индекса заданий, пропавших из выдачи |
| **reliable source** | URL, который в этом проходе получен и разобран успешно |
| **hard anomaly** | показанная проверка/блокировка → остановка |
| **soft anomaly** | упоминание защиты в скрипте → игнорируется |
| **hard stop reason** | причина, при которой опрос останавливается без повторов |
| **pendingNotifications** | очередь недоставленных сообщений |
| **окно опроса** | 05:00–19:00 Europe/Moscow |
| **immediate / wait / nextWindow / paused** | решения планировщика по шагу |
| **firstRequestNoDelay** | первый запрос после старта — без паузы |
| **last_page / total** | метаданные выдачи: сколько страниц и заданий всего |
| **maxPagesPerUrl** | верхняя граница автопрохода по страницам |
| **categoryMapping** | соответствие числовых id Kwork вашим категориям |
| **preflight** | финальная проверка перед живым запуском |
| **bootstrap** | сборка всех зависимостей в `src/index.js` |
| **texts** | объект текстов интерфейса, создаётся один раз на процесс из `config/texts.json` |
| **контракт текстов** | список путей и ожидаемых плейсхолдеров, сверяется тестом |
| **TEXTS_FILE** | переменная окружения с путём к локальному файлу текстов |
| **prune / reliable source** | очистка индекса только по источникам, полученным в этом проходе |
| **keyTotal** | общее число ключей дедупликации в индексе (обычно вдвое больше числа заданий) |
| **activeJobCount** | число актуальных заданий в индексе (уникальные dedupKey) |
| **pendingNotifications** | очередь недоставленных сообщений (не более 50) |
| **systemd-юнит** | способ автозапуска бота на сервере (`docs/DEPLOY-VPS.md`) |
| **владелец** | пользователь из `TELEGRAM_ALLOWED_USER_ID`; подтверждает доступ остальным |
| **approvedUsers / pendingUsers** | списки доступа и ожидающих решения в `data/telegram-state.json` |
| **autoApprove** | режим, при котором доступ выдаётся сразу при `/start` |
| **setMyCommands** | вызов Telegram, публикующий команды в меню бота |
| **scope (Telegram)** | область видимости меню: без неё — всем, `chat` — конкретному чату |
| **ownerOnly** | команды `/users`, `/approve`, `/deny`, доступные только владельцу |
| **ProfileStore** | хранилище профилей на пользователя с приоритетом «личный → общий» |
| **отпечаток меню** | хеш набора команд: по нему решается, нужна ли повторная публикация |
| **recipients** | список «userId + chatId», которым уходят уведомления |
| **categoryCatalog** | справочник id → название категории Kwork (полный — в `config/categories.json`) |
| **attribute** | подраздел внутри категории: `/projects?c=<id>&attr=<id>` |
| **searchCatalog** | поиск по каталогу с нормализацией ё/е, й/и, регистра и разделителей |
| **CategoryPreferences** | персональный выбор категорий пользователя |
| **profile-guard** | набор проверок загружаемого файла профиля |
| **preflightJson** | проверка текста до JSON.parse: размер, глубина, баланс скобок |
| **metrics** | накопительные счётчики приложения в `state.json` |
| **эвристика** | локальный анализ без нейросети (режим по умолчанию) |
| **план опроса** | список URL, которые бот запросит в цикле, по выбранным категориям |
| **seenUsers** | кто из пользователей уже подключался (для лога «новый пользователь») |
| **long polling** | режим getUpdates, при котором Telegram держит соединение до 30 с |
| **бюджет модели** | лимит запросов к модели на сутки и час (`model.usage`) |
| **selective-режим** | вызов модели только при неуверенности эвристики |
| **OpenAI-совместимый эндпоинт** | `POST {base}/chat/completions` — то, что умеет адаптер |
