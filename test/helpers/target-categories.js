/**
 * Тестовый список «целевых» категорий и маппинг id Kwork → id категории.
 *
 * В рабочем конфиге такого списка НЕТ: источник названий — каталог сайта
 * (config/categories.json), подписи подставляет applyCategoryName в цикле.
 * Здесь список нужен, чтобы проверить сам механизм сопоставления парсера
 * (matchTargetCategory / matchEmbeddedCategory) отдельно от каталога.
 */

export const TARGET_CATEGORIES = [
  {
    "id": "site-creation-new",
    "priority": 3,
    "label": "Создание сайта - Новый сайт",
    "section": "Создание сайта",
    "subsection": "Новый сайт",
    "matchHint": [
      "создание сайта",
      "новый сайт",
      "разработка сайта",
      "лендинг",
      "сайт-визитка"
    ],
    "kworkCategoryId": 37,
    "url": "/projects?c=37",
    "attribute": "Новый сайт"
  },
  {
    "id": "site-repair-editing",
    "priority": 4,
    "label": "Доработка и настройка сайта - Доработка сайта",
    "section": "Доработка и настройка сайта",
    "subsection": "Доработка сайта",
    "matchHint": [
      "доработка сайта",
      "настройка сайта",
      "правки сайта"
    ],
    "kworkCategoryId": 38,
    "url": "/projects?c=38",
    "attribute": "Доработка сайта"
  },
  {
    "id": "markup-by-layout",
    "priority": 2,
    "label": "Верстка - Верстка по макету",
    "section": "Верстка",
    "subsection": "Верстка по макету",
    "matchHint": [
      "верстка по макету",
      "вёрстка по макету",
      "figma",
      "psd",
      "верстка",
      "вёрстка"
    ],
    "kworkCategoryId": 79,
    "url": "/projects?c=79",
    "attribute": "Верстка по макету"
  },
  {
    "id": "markup-adaptation",
    "priority": 1,
    "label": "Верстка - Доработка и адаптация верстки",
    "section": "Верстка",
    "subsection": "Доработка и адаптация верстки",
    "matchHint": [
      "адаптация верстки",
      "адаптивная верстка",
      "правка верстки",
      "адаптив",
      "доработка верстки"
    ],
    "kworkCategoryId": 79,
    "url": "/projects?c=79",
    "attribute": "Доработка и адаптация верстки"
  }
];

/** Маппинг category_id Kwork → id «целевой» категории (для тестов парсера). */
export const CATEGORY_MAPPING = {
  "37": "site-creation-new",
  "38": "site-repair-editing",
  "79": "markup-by-layout"
};
