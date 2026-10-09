import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JobStore, checkDuplicate, addToIndex, keysForJob, normalizeUrlKey, pruneIndex, activeJobCount } from '../src/storage/job-store.js';

function makeJob(overrides = {}) {
  return {
    id: '1001',
    url: 'https://kwork.ru/projects/1001/verstka-lendinga',
    title: 'Вёрстка лендинга',
    budget: { min: 5000, max: 5000, text: '5 000 ₽', currency: 'RUB' },
    dedupKey: 'id:1001',
    dedupKind: 'stable-id',
    missingFields: [],
    ...overrides
  };
}

test('normalizeUrlKey убирает query и хвостовой слэш', () => {
  assert.equal(normalizeUrlKey('https://kwork.ru/projects/1/a?ref=list#x'), 'https://kwork.ru/projects/1/a');
  assert.equal(normalizeUrlKey('https://kwork.ru/projects/1/a/'), 'https://kwork.ru/projects/1/a');
  assert.equal(normalizeUrlKey(null), null);
});

test('keyForJob даёт ровно один ключ по приоритету: id → ссылка → составной', () => {
  assert.deepEqual(keysForJob(makeJob()).map((key) => key.type), ['stable-id']);
  assert.deepEqual(keysForJob(makeJob({ id: null })).map((key) => key.type), ['url']);
  assert.deepEqual(
    keysForJob(makeJob({ id: null, url: null, dedupKey: 'composite:abc123' })).map((key) => key.type),
    ['composite']
  );
  assert.deepEqual(keysForJob({ id: null, url: null, dedupKey: null }), []);
});

test('дедупликация: повторная карточка не создаёт дубликат', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    const job = makeJob();

    const first = await store.record(job, { recordedAt: '2026-10-07T05:00:00.000Z' });
    assert.equal(first.recorded, true);

    const second = await store.record(job, { recordedAt: '2026-10-07T05:05:00.000Z' });
    assert.equal(second.recorded, false);
    assert.equal(second.duplicate.isDuplicate, true);
    assert.equal(second.duplicate.matchedBy, 'stable-id');

    const lines = (await readFile(join(dir, 'processed-jobs.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'в журнал должна попасть ровно одна запись');
    assert.equal(store.stats.total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('та же ссылка без изменений id считается дубликатом по url', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    await store.record(makeJob({ id: null, dedupKey: 'url:https://kwork.ru/projects/1001/verstka-lendinga', dedupKind: 'url' }));
    const duplicate = store.isProcessed(
      makeJob({
        id: null,
        url: 'https://kwork.ru/projects/1001/verstka-lendinga?utm=1',
        dedupKey: 'url:https://kwork.ru/projects/1001/verstka-lendinga',
        dedupKind: 'url'
      })
    );
    assert.equal(duplicate.isDuplicate, true);
    assert.equal(duplicate.matchedBy, 'url');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('старый индекс с двумя ключами (id и ссылка) продолжает распознавать повторы', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    // Имитируем индекс прежнего формата: задание записано и по id, и по ссылке.
    const job = makeJob();
    store.index = addToIndex(job, store.index);
    store.index.keys.url['https://kwork.ru/projects/1001/verstka-lendinga'] = store.index.keys.stableId['1001'];
    assert.equal(store.isProcessed(job).isDuplicate, true);
    // И задание без id, но с той же ссылкой тоже распознаётся как повтор.
    const byUrl = store.isProcessed(makeJob({ id: null, dedupKey: 'url:https://kwork.ru/projects/1001/verstka-lendinga' }));
    assert.equal(byUrl.isDuplicate, true);
    assert.equal(byUrl.matchedBy, 'url');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('составной ключ помечается как возможное совпадение', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    const job = makeJob({ id: null, url: null, dedupKey: 'composite:abc123', dedupKind: 'composite-fallback' });
    await store.record(job);
    const duplicate = store.isProcessed(job);
    assert.equal(duplicate.isDuplicate, true);
    assert.equal(duplicate.matchedBy, 'composite');
    assert.equal(duplicate.probableMatch, true, 'составной ключ не должен считаться точным совпадением');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('индекс и журнал переживают перезапуск процесса', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const first = await new JobStore({ dataDir: dir }).init();
    await first.record(makeJob());

    const second = await new JobStore({ dataDir: dir }).init();
    assert.equal(second.stats.total, 1);
    const duplicate = second.isProcessed(makeJob());
    assert.equal(duplicate.isDuplicate, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('состояние сохраняется и читается', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    await store.writeState({ scheduler: { status: 'paused', requestCount: 3 } });
    const state = await store.readState();
    assert.equal(state.scheduler.status, 'paused');
    assert.equal(state.scheduler.requestCount, 3);
    assert.ok(state.updatedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkDuplicate без ключей сообщает noStableKey', () => {
  const result = checkDuplicate({ id: null, url: null, dedupKey: null }, { keys: { stableId: {}, url: {}, composite: {} } });
  assert.equal(result.isDuplicate, false);
  assert.equal(result.noStableKey, true);
});

test('addToIndex не мутирует исходный индекс', () => {
  const index = { keys: { stableId: {}, url: {}, composite: {} }, total: 0 };
  const next = addToIndex(makeJob(), index);
  assert.equal(index.total, 0);
  assert.equal(next.total, 1);
  const entry = next.keys.stableId['1001'];
  assert.equal(entry.dedupKey, 'id:1001');
  assert.equal(entry.title, 'Вёрстка лендинга');
  assert.ok(entry.recordedAt, 'в записи должно быть время');
});

test('запись индекса хранит url задания и url списка раздельно', () => {
  const index = { keys: { stableId: {}, url: {}, composite: {} }, total: 0 };
  const next = addToIndex(makeJob(), index, {
    sourceRef: { url: 'https://kwork.ru/projects?c=37', kworkCategoryId: 37, title: 'Вёрстка лендинга' }
  });
  const entry = next.keys.stableId['1001'];
  // sourceUrl — адрес самого задания, а не списка категории.
  assert.equal(entry.sourceUrl, 'https://kwork.ru/projects/1001/verstka-lendinga');
  assert.equal(entry.listingUrl, 'https://kwork.ru/projects?c=37');
  assert.equal(entry.kworkCategoryId, 37);
});

test('старый формат sourceUrl-категория мигрирует в listingUrl при чтении', () => {
  const index = {
    keys: {
      stableId: { '1': { dedupKey: 'id:1', sourceUrl: 'https://kwork.ru/projects?c=37', title: 'A' } },
      url: {},
      composite: {}
    },
    total: 1
  };
  // seenKeys пустой, но источник c=37 надёжен → задание удаляется, значит legacy sourceUrl
  // был правильно распознан как listingUrl (иначе задание осталось бы «защищённым»).
  const { removed } = pruneIndex(index, new Set(), {
    reliableSourceUrls: new Set(['https://kwork.ru/projects?c=37'])
  });
  assert.equal(removed.stableId, 1, 'legacy sourceUrl-категория должна мигрировать в listingUrl');
});

test('activeJobCount считает уникальные задания, а не ключи', () => {
  const index = {
    keys: {
      stableId: { 1: { dedupKey: 'id:1' }, 2: { dedupKey: 'id:2' } },
      url: { 'https://kwork.ru/projects/1': { dedupKey: 'id:1' } },
      composite: {}
    }
  };
  assert.equal(activeJobCount(index), 2);
  assert.equal(activeJobCount({ keys: {} }), 0);
});

test('pruneIndex удаляет пропавшие задания только у надёжных источников', () => {
  const index = {
    keys: {
      stableId: {
        1: { dedupKey: 'id:1', sourceUrl: 'https://kwork.ru/projects?c=37', title: 'A' },
        2: { dedupKey: 'id:2', sourceUrl: 'https://kwork.ru/projects?c=38', title: 'B' }
      },
      url: {},
      composite: {}
    },
    total: 2
  };
  // job 1 видели, job 2 — нет; надёжен только источник c=37.
  const seenKeys = new Set(['stableId:1']);
  const { index: next, removed } = pruneIndex(index, seenKeys, {
    reliableSourceUrls: new Set(['https://kwork.ru/projects?c=37'])
  });
  assert.equal(removed.stableId, 0, 'job 2 из ненадёжного источника не удаляем');
  assert.ok(next.keys.stableId['2'], 'задание из неполученного источника сохраняется');

  // Теперь оба источника надёжны: пропавшее задание удаляется.
  const second = pruneIndex(index, seenKeys, {
    reliableSourceUrls: new Set(['https://kwork.ru/projects?c=37', 'https://kwork.ru/projects?c=38'])
  });
  assert.equal(second.removed.stableId, 1);
  assert.equal(second.index.keys.stableId['2'], undefined);
  assert.ok(second.index.keys.stableId['1']);
});

test('pruneIndex не удаляет записи старого формата без источника', () => {
  const index = { keys: { stableId: { 5: 'id:5' }, url: {}, composite: {} }, total: 1 };
  const { removed, index: next } = pruneIndex(index, new Set(), {
    reliableSourceUrls: new Set(['https://kwork.ru/projects'])
  });
  assert.equal(removed.stableId, 0, 'неизвестный источник трогать нельзя');
  assert.equal(next.keys.stableId['5'], 'id:5');
});

test('readProcessedTail отдаёт последние записи', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    await store.record(makeJob({ id: '1', dedupKey: 'id:1', url: 'https://kwork.ru/projects/1/a' }));
    await store.record(makeJob({ id: '2', dedupKey: 'id:2', url: 'https://kwork.ru/projects/2/a' }));
    const tail = await store.readProcessedTail(1);
    assert.equal(tail.length, 1);
    assert.equal(tail[0].id, '2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('задание хранится под одним ключом: total = число ключей', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    await store.record(makeJob()); // у задания есть и id, и url, но ключ один
    const stats = store.stats;
    assert.equal(stats.total, 1);
    assert.equal(stats.stableIdKeys, 1);
    assert.equal(stats.urlKeys, 0, 'ссылка не дублирует задание отдельным ключом');
    assert.equal(stats.keyTotal, 1, 'один ключ на задание');
    assert.equal(stats.keyTotal, stats.total);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('10 заданий дают total 10 и keyTotal 10', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kwork-store-'));
  try {
    const store = await new JobStore({ dataDir: dir }).init();
    for (let i = 1; i <= 10; i += 1) {
      await store.record(
        makeJob({ id: String(1000 + i), url: `https://kwork.ru/projects/${1000 + i}/slug`, dedupKey: `id:${1000 + i}` })
      );
    }
    const stats = store.stats;
    assert.equal(stats.total, 10);
    assert.equal(stats.keyTotal, 10);
    assert.equal(store.activeJobs().length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
