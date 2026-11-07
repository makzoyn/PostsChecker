// Подмена chrome.* и VK API для проверки дашборда вне расширения. В сборку расширения не входит.
const memory = new Map();

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

const GROUPS = [
  { id: 101, name: 'Находки для дома', screen_name: 'club101', members_count: 48200, base: 5200, step: 0.6 },
  { id: 102, name: 'Кухня без лишнего', screen_name: 'club102', members_count: 12800, base: 1900, step: 1.1 },
  { id: 103, name: 'Очень длинное название сообщества про садовые инструменты и рассаду', screen_name: 'club103', members_count: 3100, base: 640, step: 2 },
  { id: 104, name: 'Закрытая стена', screen_name: 'club104', members_count: 90, base: 0, step: 3, wallError: 15 },
  { id: 105, name: 'Тихий канал', screen_name: 'club105', members_count: 12, base: 30, step: 40 },
];

const TEXTS = [
  'Складная сушилка, которая помещается за дверью ванной и держит пять килограммов белья',
  'Сравнили четыре недорогих блендера: какой справился со льдом',
  'Подборка органайзеров для ящиков до 500 рублей',
  '',
  'Лампа с датчиком движения для тёмного коридора. Заряда хватает на месяц.',
  '<img src=x onerror="window.__xss = true"> проверка, что текст поста не становится разметкой',
];

function wallFor(group) {
  const random = seeded(group.id);
  const now = Math.floor(Date.now() / 1000);
  const items = [];
  // Посты от новых к старым, первый из них закреплён и очень старый.
  items.push({
    id: 1, owner_id: -group.id, date: now - 400 * 86400, text: 'Закреплённый пост про правила сообщества',
    is_pinned: 1, views: { count: group.base * 9 }, likes: { count: 40 }, reposts: { count: 8 }, comments: { count: 3 },
  });
  for (let index = 0; index * group.step < 420; index += 1) {
    const views = Math.round(group.base * (0.4 + random() * 1.6) * (random() > 0.93 ? 4 : 1));
    items.push({
      id: 1000 - index,
      owner_id: -group.id,
      date: Math.floor(now - (index * group.step + 0.2) * 86400),
      text: TEXTS[index % TEXTS.length],
      attachments: [{ type: index % 2 ? 'photo' : 'video' }],
      // У каждого седьмого поста нет поля views: так бывает в реальных ответах.
      ...(index % 7 === 6 ? {} : { views: { count: views } }),
      likes: { count: Math.round(views * 0.03) },
      reposts: { count: Math.round(views * 0.004) },
      comments: { count: Math.round(views * 0.002) },
      marked_as_ads: index % 11 === 0 ? 1 : 0,
      ...(index % 13 === 0 ? { copy_history: [{}] } : {}),
    });
  }
  return items;
}

function respond(method, params) {
  if (method === 'groups.get') {
    return {
      response: {
        count: GROUPS.length,
        items: GROUPS.map(({ id, name, screen_name, members_count }) => ({ id, name, screen_name, members_count })),
      },
    };
  }
  if (method === 'groups.getById') {
    const names = params.get('group_ids').split(',');
    const items = GROUPS.filter((group) => names.includes(group.screen_name));
    return {
      response: {
        groups: items.map(({ id, name, screen_name, members_count }) => ({ id, name, screen_name, members_count })),
      },
    };
  }
  if (method === 'wall.get') {
    const group = GROUPS.find((item) => item.screen_name === params.get('domain'));
    if (!group) return { error: { error_code: 100, error_msg: 'One of the parameters specified was missing or invalid' } };
    if (group.wallError) return { error: { error_code: group.wallError, error_msg: 'Access denied: wall is disabled' } };
    const items = wallFor(group);
    const offset = Number(params.get('offset'));
    return { response: { count: items.length, items: items.slice(offset, offset + Number(params.get('count'))) } };
  }
  return { error: { error_code: 3, error_msg: `Unknown method ${method}` } };
}

// Условные заявки в формате ответа кабинета, связанные с постами из wallFor().
function placement(number, publishedUrl, name, statusCode, clicks, predicted, earned) {
  return {
    number,
    publishedUrl,
    publishDateTime: publishedUrl ? new Date(Date.now() - 86400000 * 3).toISOString() : undefined,
    sum100: earned,
    status: { code: statusCode, expiresAt: new Date(Date.now() + 86400000 * 12).toISOString() },
    stats: { clickCount: clicks, cpm100: 0, predictedReward: predicted },
    product: { name, price100: 60000, rate1000: 8000 },
    community: { title: 'Находки для дома', link: 'https://vk.ru/club101' },
  };
}

const PLACEMENTS = [
  placement('5001', 'https://vk.ru/wall-101_1000', 'Сушилка складная', 'SummarizedPlacementStatusCodeInProgress', 96, 450, 12000),
  placement('5002', 'https://vk.com/wall-101_990', 'Лампа с датчиком', 'SummarizedPlacementStatusCodeInProgress', 41, 56, 0),
  placement('5003', 'https://vk.ru/wall-102_995', 'Набор органайзеров', 'SummarizedPlacementStatusCodeInProgress', 12, 18, 950),
  placement('5004', 'https://vk.ru/wall-999_5', 'Товар в другом сообществе', 'SummarizedPlacementStatusCodeInProgress', 3, 1, 700),
  placement('5005', undefined, 'Трос буксировочный', 'SummarizedPlacementStatusCodeAOInModeration', 0, 0, 0),
  placement('5006', undefined, 'Чай подарочный', 'SummarizedPlacementStatusCodeScheduled', 0, 0, 0),
];

// cabinet: 'responds' имитирует кабинет, который отдаёт заявки, 'silent' имитирует страницу входа.
export function installMock({ connected = true, adblogger = false, cabinet = 'responds' } = {}) {
  const storageListeners = new Set();
  const removedListeners = new Set();
  const notify = (key, newValue) => {
    for (const listener of storageListeners) listener({ [key]: { newValue } }, 'local');
  };
  window.__mockTabs = { created: [], removed: [], activated: [] };
  if (connected) memory.set('auth', { accessToken: 'mock', manual: true });
  if (adblogger) {
    memory.set('adblogger', globalThis.VkViewsAdblogger.mergePlacements(null, PLACEMENTS, Date.now() / 1000));
  }
  window.chrome = {
    runtime: { id: 'mockextensionid' },
    storage: {
      onChanged: {
        addListener: (listener) => storageListeners.add(listener),
        removeListener: (listener) => storageListeners.delete(listener),
      },
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => memory.has(key)).map((key) => [key, memory.get(key)]));
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) {
            memory.set(key, structuredClone(value));
            notify(key, value);
          }
        },
        async remove(key) { memory.delete(key); },
      },
    },
    tabs: {
      create: async (options) => {
        window.__mockTabs.created.push(options);
        if (cabinet === 'responds') {
          setTimeout(() => {
            const next = globalThis.VkViewsAdblogger.mergePlacements(memory.get('adblogger'), PLACEMENTS, Date.now() / 1000);
            window.chrome.storage.local.set({ adblogger: next });
          }, 300);
        }
        return { id: 7 };
      },
      update: async (id, options) => { window.__mockTabs.activated.push({ id, ...options }); },
      remove: async (id) => {
        window.__mockTabs.removed.push(id);
        for (const listener of removedListeners) listener(id);
      },
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: {
        addListener: (listener) => removedListeners.add(listener),
        removeListener: (listener) => removedListeners.delete(listener),
      },
    },
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    const match = String(url).match(/^https:\/\/api\.vk\.ru\/method\/(.+)$/);
    if (!match) return realFetch(url, init);
    return new Response(JSON.stringify(respond(match[1], init.body)));
  };
}
