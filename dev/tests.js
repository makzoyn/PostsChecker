import { codeChallenge, parseRedirect } from '../extension/lib/auth.js';
import { parseGroupLink, parseGroupLinks } from '../extension/lib/group-links.js';
import { fetchGroups, fetchWall, loadAll, resolveGroups } from '../extension/lib/loader.js';
import {
  MATURE_AGE_SEC, baselineViews, buildStats, median, postPerformance, selectPosts, trimPost,
} from '../extension/lib/stats.js';
import { VkApiError, createVkClient } from '../extension/lib/vk-api.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function assertEqual(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} ожидалось ${b}, получено ${a}`);
}

async function assertRejects(promise, check) {
  let error = null;
  try { await promise; } catch (caught) { error = caught; }
  if (!error) throw new Error('ожидалась ошибка');
  check(error);
}

const NOW = 1_800_000_000;
const DAY = 86_400;
const post = (id, ageDays, views) => ({ id, date: NOW - ageDays * DAY, views, text: `post ${id}` });
const noSleep = async () => {};

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params });
      return handler(method, params, calls.length);
    },
  };
}

// Статистика

test('median: чётное, нечётное и пустое', () => {
  assertEqual(median([3, 1, 2]), 2);
  assertEqual(median([4, 1, 2, 3]), 2.5);
  assertEqual(median([]), null);
});

test('trimPost: нет views значит null, а не 0', () => {
  assertEqual(trimPost({ id: 1, owner_id: -1, date: 1 }).views, null);
  assertEqual(trimPost({ id: 1, owner_id: -1, date: 1, views: { count: 0 } }).views, 0);
});

test('baselineViews: свежие посты и посты без данных не считаются', () => {
  const posts = [post(1, 3, 100), post(2, 4, 200), post(3, 5, 300), post(4, 1, 99999), post(5, 6, null)];
  assertEqual(baselineViews(posts, NOW), 200);
});

test('baselineViews: меньше трёх зрелых постов значит null', () => {
  assertEqual(baselineViews([post(1, 3, 100), post(2, 4, 200)], NOW), null);
});

test('postPerformance: граница зрелости и отсутствующие данные', () => {
  assertEqual(postPerformance({ date: NOW - MATURE_AGE_SEC, views: 300 }, 100, NOW), 3);
  assertEqual(postPerformance({ date: NOW - MATURE_AGE_SEC + 1, views: 300 }, 100, NOW), null);
  assertEqual(postPerformance({ date: NOW - 9 * DAY, views: null }, 100, NOW), null);
  assertEqual(postPerformance({ date: NOW - 9 * DAY, views: 300 }, null, NOW), null);
  assertEqual(postPerformance({ date: NOW - 9 * DAY, views: 300 }, 0, NOW), null);
});

test('buildStats: период, суммы и порядок сообществ', () => {
  const groups = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
  const stats = buildStats(groups, {
    1: [post(1, 3, 10), post(2, 40, 1000)],
    2: [post(3, 3, 50), post(4, 4, null)],
  }, 30, NOW);
  assertEqual(stats.totalViews, 60);
  assertEqual(stats.totalPosts, 3);
  assertEqual(stats.groups.map((group) => group.id), [2, 1]);
});

test('selectPosts: посты без данных внизу при любом порядке', () => {
  const rows = [post(1, 1, null), post(2, 2, 5), post(3, 3, 9)].map((row) => ({ ...row, groupId: 1 }));
  assertEqual(selectPosts([...rows], { sortDir: 'desc' }).map((row) => row.id), [3, 2, 1]);
  assertEqual(selectPosts([...rows], { sortDir: 'asc' }).map((row) => row.id), [2, 3, 1]);
});

test('selectPosts: фильтр по сообществу и поиск без учёта регистра', () => {
  const rows = [{ ...post(1, 1, 1), text: 'Лампа', groupId: 1 }, { ...post(2, 1, 2), text: 'лампа', groupId: 2 }, { ...post(3, 1, 3), text: 'Стол', groupId: 1 }];
  assertEqual(selectPosts(rows, { groupId: 1, query: 'ЛАМП' }).map((row) => row.id), [1]);
});

// Авторизация

test('codeChallenge: контрольный пример из RFC 7636', async () => {
  assertEqual(await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('parseRedirect: чужой адрес игнорируется, в том числе адрес входа с redirect_uri внутри', () => {
  const redirect = 'https://ext.chromiumapp.org/';
  assertEqual(parseRedirect(`https://id.vk.ru/authorize?redirect_uri=${encodeURIComponent(redirect)}`, redirect, 's'), null);
});

test('parseRedirect: успех, неверный state и ошибка VK', () => {
  const redirect = 'https://ext.chromiumapp.org/';
  assertEqual(parseRedirect(`${redirect}?code=c&device_id=d&state=s`, redirect, 's'), { code: 'c', deviceId: 'd' });
  let threw = false;
  try { parseRedirect(`${redirect}?code=c&device_id=d&state=evil`, redirect, 's'); } catch { threw = true; }
  assertEqual(threw, true, 'state');
  threw = false;
  try { parseRedirect(`${redirect}?error=access_denied`, redirect, 's'); } catch { threw = true; }
  assertEqual(threw, true, 'error');
});

// Клиент API

const jsonResponse = (body) => new Response(JSON.stringify(body));
const apiError = (code) => jsonResponse({ error: { error_code: code, error_msg: `e${code}` } });

test('client: передаёт ключ, версию и адрес из документации', async () => {
  let seen = null;
  const client = createVkClient({
    getToken: async () => 'tok',
    sleep: noSleep,
    fetchFn: async (url, init) => { seen = { url, init }; return jsonResponse({ response: 1 }); },
  });
  assertEqual(await client.call('groups.get', { a: 1 }), 1);
  assertEqual(seen.url, 'https://api.vk.ru/method/groups.get');
  assertEqual(seen.init.headers.Authorization, 'Bearer tok');
  assertEqual(seen.init.body.get('v'), '5.131');
});

test('client: при ошибке 6 ждёт и повторяет', async () => {
  let count = 0;
  const client = createVkClient({
    getToken: async () => 't',
    sleep: noSleep,
    fetchFn: async () => { count += 1; return count < 3 ? apiError(6) : jsonResponse({ response: 'ok' }); },
  });
  assertEqual(await client.call('m'), 'ok');
  assertEqual(count, 3);
});

test('client: при ошибке 6 сдаётся после лимита попыток', async () => {
  const client = createVkClient({ getToken: async () => 't', sleep: noSleep, fetchFn: async () => apiError(6) });
  await assertRejects(client.call('m'), (error) => assertEqual(error.code, 6));
});

test('client: при ошибке 5 обновляет ключ один раз и сообщает, какой отвергнут', async () => {
  const requests = [];
  const tokens = [];
  const client = createVkClient({
    getToken: async (options) => { requests.push(options?.rejectedToken ?? null); return requests.length === 1 ? 'old' : 'new'; },
    sleep: noSleep,
    fetchFn: async (url, init) => {
      tokens.push(init.headers.Authorization);
      return init.headers.Authorization === 'Bearer new' ? jsonResponse({ response: 'ok' }) : apiError(5);
    },
  });
  assertEqual(await client.call('m'), 'ok');
  assertEqual(requests, [null, 'old']);
  assertEqual(tokens, ['Bearer old', 'Bearer new']);
});

test('client: повторная ошибка 5 не зацикливается', async () => {
  let count = 0;
  const client = createVkClient({
    getToken: async () => 't', sleep: noSleep, fetchFn: async () => { count += 1; return apiError(5); },
  });
  await assertRejects(client.call('m'), (error) => assertEqual(error.code, 5));
  assertEqual(count, 2);
});

test('client: параллельные вызовы идут последовательно с паузой', async () => {
  let active = 0;
  let maxActive = 0;
  const gaps = [];
  const client = createVkClient({
    getToken: async () => 't',
    sleep: async (ms) => { gaps.push(ms); },
    minIntervalMs: 350,
    fetchFn: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return jsonResponse({ response: 1 });
    },
  });
  await Promise.all([client.call('a'), client.call('b'), client.call('c')]);
  assertEqual(maxActive, 1);
  assertEqual(gaps.slice(0, 2), [350, 350]);
});

// Загрузка

test('fetchGroups: фильтр moder, листает до конца', async () => {
  const client = fakeClient((method, params) => ({
    count: 1001,
    items: params.offset === 0
      ? Array.from({ length: 1000 }, (_, id) => ({ id, name: 'n', screen_name: 's' }))
      : [{ id: 1000, name: 'n', screen_name: 's' }],
  }));
  const groups = await fetchGroups(client);
  assertEqual(groups.length, 1001);
  assertEqual(client.calls.length, 2);
  assertEqual(client.calls[0].params.filter, 'moder');
});

test('fetchWall: старый закреплённый пост не останавливает загрузку', async () => {
  const client = fakeClient((method, params) => ({
    count: 3,
    items: [
      { id: 1, owner_id: -1, date: NOW - 400 * DAY, is_pinned: 1 },
      { id: 2, owner_id: -1, date: NOW - DAY },
      { id: 3, owner_id: -1, date: NOW - 2 * DAY },
    ].slice(params.offset, params.offset + params.count),
  }));
  const posts = await fetchWall(client, { screenName: 'x' }, 30, NOW);
  assertEqual(posts.map((item) => item.id), [2, 3]);
  assertEqual(client.calls[0].params.domain, 'x');
});

test('fetchWall: останавливается на первом старом посте', async () => {
  const items = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, owner_id: -1, date: NOW - index * DAY }));
  const client = fakeClient((method, params) => ({ count: 300, items: items.slice(params.offset, params.offset + params.count) }));
  const posts = await fetchWall(client, { screenName: 'x' }, 150, NOW);
  assertEqual(client.calls.length, 2);
  assertEqual(posts.length, 151);
});

test('fetchWall: повтор записи на границе страниц схлопывается', async () => {
  const pages = [
    [{ id: 2, owner_id: -1, date: NOW }],
    [{ id: 2, owner_id: -1, date: NOW }, { id: 1, owner_id: -1, date: NOW }],
  ];
  let page = 0;
  const client = fakeClient(() => ({ count: 201, items: pages[page++] ?? [] }));
  assertEqual((await fetchWall(client, { screenName: 'x' }, 30, NOW)).length, 2);
});

function clientWithWall(wallHandler) {
  return fakeClient((method, params) => (method === 'groups.get'
    ? { count: 3, items: [1, 2, 3].map((id) => ({ id, name: `g${id}`, screen_name: `g${id}` })) }
    : wallHandler(params)));
}

test('loadAll: ошибка одного сообщества не мешает остальным и оставляет старые посты', async () => {
  const client = clientWithWall((params) => {
    if (params.domain === 'g2') throw new VkApiError(15, 'denied', 'wall.get');
    return { count: 1, items: [{ id: 9, owner_id: -1, date: NOW }] };
  });
  const previous = { loadedDays: 7, postsByGroup: { 2: [post(5, 1, 1)] } };
  const result = await loadAll({ client, days: 30, now: NOW, previous });
  assertEqual(result.errors[2], 'denied');
  assertEqual(result.postsByGroup[1].length, 1);
  assertEqual(result.postsByGroup[2][0].id, 5);
  assertEqual(result.postsByGroup[3].length, 1);
  assertEqual(result.fatal, null);
  assertEqual(result.loadedDays, 30);
});

test('loadAll: капча останавливает запросы и не повышает глубину данных', async () => {
  const client = clientWithWall(() => { throw new VkApiError(14, 'captcha', 'wall.get'); });
  const result = await loadAll({ client, days: 365, now: NOW, previous: { loadedDays: 30, postsByGroup: {} } });
  assertEqual(result.fatal.code, 14);
  assertEqual(client.calls.filter((call) => call.method === 'wall.get').length, 1);
  assertEqual(result.loadedDays, 30);
});

// Ссылки на сообщества

test('parseGroupLink: понимает разные формы ссылок', () => {
  const cases = {
    'https://vk.com/nahodki': 'nahodki',
    'http://vk.com/nahodki/': 'nahodki',
    'https://m.vk.com/club123': 'club123',
    'https://vk.ru/public456?from=feed': 'public456',
    'vk.com/event789': 'event789',
    '@nahodki': 'nahodki',
    'nahodki.home': 'nahodki.home',
    'https://vk.com/wall-123_45': 'club123',
    '  https://vk.com/spaced  ': 'spaced',
  };
  for (const [input, expected] of Object.entries(cases)) assertEqual(parseGroupLink(input), expected, input);
});

test('parseGroupLink: отклоняет чужие сайты и пустые пути', () => {
  for (const input of ['https://example.com/nahodki', 'https://vk.com.evil.ru/nahodki', 'https://vk.com/', 'vk.com', 'https://vk.com/a%20b', '']) {
    assertEqual(parseGroupLink(input), null, input);
  }
});

test('parseGroupLinks: разделители, повторы и ошибочные строки', () => {
  const { domains, invalid } = parseGroupLinks('https://vk.com/a\nhttps://vk.com/A, club1  https://example.com/x\n\n');
  assertEqual(domains, ['a', 'club1']);
  assertEqual(invalid, ['https://example.com/x']);
});

test('resolveGroups: оба формата ответа и сообщество по club-имени', async () => {
  const groups = [{ id: 1, name: 'Первое', screen_name: 'first' }, { id: 2, name: 'Второе', screen_name: 'second' }];
  assertEqual((await resolveGroups(fakeClient(() => groups), ['first']))[0].name, 'Первое');
  const resolved = await resolveGroups(fakeClient(() => ({ groups })), ['club2', 'FIRST']);
  assertEqual(resolved.map((group) => group.id), [2, 1]);
  assertEqual(resolved[0].screenName, 'club2');
});

test('resolveGroups: без данных от VK сообщество остаётся в списке под своим именем', async () => {
  const client = fakeClient(() => { throw new VkApiError(15, 'denied', 'groups.getById'); });
  assertEqual(await resolveGroups(client, ['first']), [{ id: 'first', name: 'first', screenName: 'first', photo: null, members: null }]);
});

test('resolveGroups: капча останавливает загрузку', async () => {
  const client = fakeClient(() => { throw new VkApiError(14, 'captcha', 'groups.getById'); });
  await assertRejects(resolveGroups(client, ['first']), (error) => assertEqual(error.code, 14));
});

test('loadAll: со списком ссылок не вызывает groups.get и читает стену по имени из ссылки', async () => {
  const client = fakeClient((method) => (method === 'groups.getById'
    ? [{ id: 7, name: 'Семь', screen_name: 'seven' }]
    : { count: 1, items: [{ id: 1, owner_id: -7, date: NOW, views: { count: 5 } }] }));
  const result = await loadAll({ client, days: 30, now: NOW, domains: ['club7'] });
  assertEqual(client.calls.some((call) => call.method === 'groups.get'), false);
  assertEqual(client.calls.find((call) => call.method === 'wall.get').params.domain, 'club7');
  assertEqual(result.postsByGroup[7].length, 1);
});

// AdBlogger: разбор и связь с постами

await import('../extension/adblogger/parse.js');
const { mergePlacements, normalizePlacement, postKey } = globalThis.VkViewsAdblogger;

const rawPlacement = (overrides = {}) => ({
  number: '70000001',
  publishedUrl: 'https://vk.ru/wall-100500_37',
  publishDateTime: new Date((NOW - DAY) * 1000).toISOString(),
  sum100: 12050,
  status: { code: 'SummarizedPlacementStatusCodeInProgress', expiresAt: new Date((NOW + DAY) * 1000).toISOString() },
  stats: { clickCount: 7, cpm100: 2500, predictedReward: 56 },
  product: { name: 'Товар', price100: 13700, rate1000: 9000 },
  community: { title: 'Сообщество', link: 'https://vk.ru/club100500' },
  ...overrides,
});

test('postKey: совпадает с ключом VK API, чужие адреса отклоняет', () => {
  assertEqual(postKey('https://vk.ru/wall-100500_37'), '-100500_37');
  assertEqual(postKey('https://vk.com/wall-1_2?from=x'), '-1_2');
  assertEqual(postKey('https://m.vk.com/wall-1_2'), '-1_2');
  for (const bad of ['https://vk.ru.evil.com/wall-1_2', 'https://evil.com/wall-1_2', 'https://vk.ru/wall1_2', '', undefined]) {
    assertEqual(postKey(bad), null, String(bad));
  }
});

test('normalizePlacement: единицы совпадают с таблицей кабинета', () => {
  const item = normalizePlacement(rawPlacement());
  assertEqual(item.priceRub, 137);
  assertEqual(item.ratePercent, 9);
  assertEqual(item.forecastRub, 56);
  assertEqual(item.earnedRub, 120.5);
  assertEqual(item.cpmRub, 25);
  assertEqual(item.postKey, '-100500_37');
});

test('normalizePlacement: мусор в полях не ломает разбор', () => {
  assertEqual(normalizePlacement({}), null);
  assertEqual(normalizePlacement(null), null);
  const item = normalizePlacement({ number: '1', stats: { clickCount: 'x' }, sum100: null, community: { link: 'javascript:alert(1)' } });
  assertEqual(item.clicks, 0);
  assertEqual(item.earnedRub, 0);
  assertEqual(item.communityLink, null);
  assertEqual(item.postKey, null);
});

test('mergePlacements: новый ответ не стирает другие заявки, а та же заявка обновляется', () => {
  const first = mergePlacements(null, [rawPlacement(), rawPlacement({ number: '2', sum100: 100 })], NOW);
  const second = mergePlacements(first, [rawPlacement({ number: '2', sum100: 300 })], NOW + 5);
  assertEqual(Object.keys(second.items).sort(), ['2', '70000001']);
  assertEqual(second.items['2'].earnedRub, 3);
  assertEqual(second.updatedAt, NOW + 5);
});

test('mergePlacements: снимает признак ошибки формата', () => {
  assertEqual(mergePlacements({ formatError: true }, [], NOW).formatError, false);
});

function adFixture() {
  const placements = mergePlacements(null, [
    rawPlacement({ number: 'a', publishedUrl: 'https://vk.ru/wall-1_10', sum100: 5000 }),
    rawPlacement({ number: 'out', publishedUrl: 'https://vk.ru/wall-99_1', sum100: 700 }),
    rawPlacement({ number: 'old', publishedUrl: 'https://vk.ru/wall-99_2', publishDateTime: new Date((NOW - 90 * DAY) * 1000).toISOString() }),
    rawPlacement({ number: 'wait', publishedUrl: undefined, publishDateTime: undefined }),
    rawPlacement({ number: 'late', publishedUrl: undefined, status: { code: 'x', expiresAt: new Date((NOW - DAY) * 1000).toISOString() } }),
  ], NOW).items;
  const posts = [
    { ...post(10, 3, 2000), ownerId: -1 },
    { ...post(11, 3, 500), ownerId: -1 },
    // Тот же номер поста, но другое сообщество: привязываться не должен.
    { ...post(10, 3, 900), ownerId: -2 },
  ];
  return buildStats(
    [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
    { 1: posts.slice(0, 2), 2: posts.slice(2) },
    30,
    NOW,
    placements,
  );
}

test('buildStats: заявка привязывается только к своему посту', () => {
  const stats = adFixture();
  const row = (owner, id) => stats.posts.find((item) => item.ownerId === owner && item.id === id);
  assertEqual(row(-1, 10).ad.number, 'a');
  assertEqual(row(-1, 10).adEarned, 50);
  assertEqual(row(-1, 10).adPerMille, 25);
  assertEqual(row(-1, 11).ad, null);
  assertEqual(row(-2, 10).ad, null);
  assertEqual(stats.adEarned, 50);
  assertEqual(stats.groups.find((group) => group.id === 1).adEarned, 50);
});

test('buildStats: без просмотров заработок на 1000 не считается', () => {
  const items = mergePlacements(null, [rawPlacement({ publishedUrl: 'https://vk.ru/wall-1_10' })], NOW).items;
  for (const views of [0, null]) {
    const stats = buildStats([{ id: 1, name: 'A' }], { 1: [{ ...post(10, 3, views), ownerId: -1 }] }, 30, NOW, items);
    assertEqual(stats.posts[0].adPerMille, null, String(views));
  }
});

test('buildStats: ещё не вышедшие и не найденные заявки', () => {
  const stats = adFixture();
  assertEqual(stats.pending.map((item) => item.number), ['wait']);
  assertEqual(stats.unmatched.map((item) => item.number), ['out']);
});

test('buildStats: без заявок всё работает как раньше', () => {
  const stats = buildStats([{ id: 1, name: 'A' }], { 1: [{ ...post(10, 3, 5), ownerId: -1 }] }, 30, NOW);
  assertEqual(stats.hasPlacements, false);
  assertEqual(stats.posts[0].ad, null);
  assertEqual(stats.adEarned, 0);
});

test('selectPosts: фильтр AdBlogger и посты без заявки внизу при сортировке', () => {
  const { posts } = adFixture();
  assertEqual(selectPosts([...posts], { onlyAd: true }).map((row) => row.ownerId), [-1]);
  assertEqual(selectPosts([...posts], { sortKey: 'adEarned', sortDir: 'asc' })[0].ad.number, 'a');
});

// AdBlogger: перехват и сохранение

const API_PATH = '/api/v1/author/soco/placements';
const realFetch = window.fetch;
const sentResponses = {};
window.fetch = async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  const path = new URL(url, location.href).pathname;
  if (sentResponses[path]) return sentResponses[path]();
  return realFetch(input);
};
await import('../extension/adblogger/hook.js');

const memoryStore = {};
window.chrome = {
  storage: {
    local: {
      get: async (key) => (key in memoryStore ? { [key]: memoryStore[key] } : {}),
      set: async (values) => { Object.assign(memoryStore, structuredClone(values)); },
    },
  },
};
await import('../extension/adblogger/bridge.js');

function nextHookMessage(timeoutMs = 200) {
  return new Promise((resolve) => {
    const done = (value) => { clearTimeout(timer); window.removeEventListener('message', handler); resolve(value); };
    const handler = (event) => { if (event.data?.source === 'vk-views-adblogger') done(event.data); };
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener('message', handler);
  });
}
const json = (body, status = 200) => () => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('hook: копирует ответ, а страница получает его нетронутым', async () => {
  sentResponses[API_PATH] = json({ items: [rawPlacement({ message: 'секретный текст', erir: { token: 't' } })] });
  const waiting = nextHookMessage();
  const response = await window.fetch(API_PATH, { method: 'POST' });
  const message = await waiting;
  assertEqual(message.items[0].number, '70000001');
  assertEqual((await response.json()).items[0].message, 'секретный текст', 'ответ страницы');
  assertEqual(JSON.stringify(message).includes('секретный'), false, 'текст поста');
  assertEqual('erir' in message.items[0], false, 'токен');
});

test('hook: понимает Request, как у клиента кабинета', async () => {
  sentResponses[API_PATH] = json({ items: [rawPlacement()] });
  const waiting = nextHookMessage();
  await window.fetch(new Request(new URL(API_PATH, location.href), { method: 'POST' }));
  assertEqual((await waiting)?.items?.length, 1);
});

test('hook: не трогает другие запросы и ответы с ошибкой', async () => {
  sentResponses['/api/v1/session'] = json({ items: [] });
  let waiting = nextHookMessage(80);
  await window.fetch('/api/v1/session');
  assertEqual(await waiting, null, 'другой адрес');
  sentResponses[API_PATH] = json({ error: 'x' }, 401);
  waiting = nextHookMessage(80);
  const response = await window.fetch(API_PATH);
  assertEqual(await waiting, null, 'код 401');
  assertEqual(response.status, 401);
});

test('hook: сообщает об изменении формата и не ломает ответ', async () => {
  sentResponses[API_PATH] = json({ rows: [] });
  let waiting = nextHookMessage();
  await window.fetch(API_PATH);
  assertEqual((await waiting)?.formatError, true, 'другая структура');
  sentResponses[API_PATH] = () => new Response('не json');
  waiting = nextHookMessage();
  const response = await window.fetch(API_PATH);
  assertEqual((await waiting)?.formatError, true, 'не JSON');
  assertEqual(await response.text(), 'не json');
});

test('bridge: сохраняет заявки, быстрые ответы не теряются', async () => {
  delete memoryStore.adblogger;
  await settle();
  window.postMessage({ source: 'vk-views-adblogger', items: [rawPlacement({ number: 'one' })] }, location.origin);
  window.postMessage({ source: 'vk-views-adblogger', items: [rawPlacement({ number: 'two' })] }, location.origin);
  await settle();
  assertEqual(Object.keys(memoryStore.adblogger.items).sort(), ['one', 'two']);
  assertEqual(memoryStore.adblogger.items.one.postKey, '-100500_37');
  assertEqual(document.getElementById('vk-views-adblogger-badge')?.textContent.includes('2'), true, 'подпись');
});

test('bridge: при ошибке формата сохраняет старые заявки и игнорирует чужие сообщения', async () => {
  await settle();
  window.postMessage({ source: 'other', items: [rawPlacement({ number: 'bad' })] }, location.origin);
  window.postMessage({ source: 'vk-views-adblogger', items: 'bad' }, location.origin);
  window.postMessage({ source: 'vk-views-adblogger', formatError: true }, location.origin);
  await settle();
  assertEqual(Object.keys(memoryStore.adblogger.items).sort(), ['one', 'two']);
  assertEqual(memoryStore.adblogger.formatError, true);
});

// Запуск

let failed = 0;
const list = document.getElementById('results');
for (const { name, fn } of tests) {
  const item = document.createElement('li');
  try {
    await fn();
    item.textContent = `ok: ${name}`;
  } catch (error) {
    failed += 1;
    item.textContent = `FAIL: ${name}: ${error.message}`;
    item.className = 'fail';
  }
  list.append(item);
}
document.getElementById('summary').textContent = `Пройдено ${tests.length - failed} из ${tests.length}`;
