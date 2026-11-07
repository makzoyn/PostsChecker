import {
  getAccessToken, getGrantedScope, getSettings, isConnected, login, logout, saveSettings, setManualToken,
} from './lib/auth.js';
import { VK_ERROR, createVkClient } from './lib/vk-api.js';
import { parseGroupLinks } from './lib/group-links.js';
import { loadAll } from './lib/loader.js';
import { MATURE_AGE_SEC, buildStats, selectPosts } from './lib/stats.js';

const CACHE_KEY = 'cache';
const VIEW_KEY = 'view';
const ADBLOGGER_KEY = 'adblogger';
const CABINET_URL = 'https://adblogger.vk.ru/app/author-placements/ad-products';
const CABINET_WAIT_MS = 20_000;
const PAGE_SIZE = 100;

const state = {
  connected: false,
  cache: null,
  adblogger: null,
  adLoading: false,
  onlyAd: false,
  days: 30,
  groupId: null,
  query: '',
  sortKey: 'views',
  sortDir: 'desc',
  limit: PAGE_SIZE,
  loading: false,
};

const COLUMNS = [
  { key: null, label: 'Пост', left: true },
  { key: 'date', label: 'Дата' },
  { key: 'views', label: 'Просмотры' },
  { key: 'score', label: 'К типичному', title: 'Во сколько раз больше просмотров, чем у типичного поста сообщества. Посты младше 2 дней не сравниваются.' },
  { key: 'likes', label: 'Лайки' },
  { key: 'reposts', label: 'Репосты' },
  { key: 'comments', label: 'Комментарии' },
];

// Деньги нужны чаще всего, поэтому они идут сразу после просмотров и не уходят за край таблицы.
const AD_COLUMNS = [
  { key: 'adEarned', label: 'Заработано' },
  { key: 'adPerMille', label: '₽ на 1000', title: 'Заработано на 1000 просмотров поста.' },
  { key: 'adForecast', label: 'Прогноз' },
  { key: 'adClicks', label: 'Клики' },
];
const COLUMNS_BEFORE_AD = 3;

// Сортировки для телефона: таблицы там нет, поэтому порядок выбирается списком.
const MOBILE_SORTS = [
  { key: 'views', dir: 'desc', label: 'По просмотрам' },
  { key: 'adEarned', dir: 'desc', label: 'По заработку', adOnly: true },
  { key: 'score', dir: 'desc', label: 'К обычному' },
  { key: 'date', dir: 'desc', label: 'Сначала новые' },
  { key: 'likes', dir: 'desc', label: 'По лайкам' },
];
const TITLE_WORDS = 6;

const AD_STATUS_LABELS = {
  SummarizedPlacementStatusCodeAOInModeration: 'На модерации',
  SummarizedPlacementStatusCodeScheduled: 'Запланирована',
};

const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat('ru-RU');
const scoreFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: '2-digit' });
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const longDateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

const moneyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

const formatNumber = (value) => numberFormat.format(Math.round(value));
const formatMoney = (value) => (value === null ? '—' : `${moneyFormat.format(value)} ₽`);

function plural(count, one, few, many) {
  const tens = count % 100;
  const units = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

// Всё из API вставляется только как текст, поэтому текст поста не может стать разметкой.
function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) element.setAttribute(key, value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined));
  return element;
}

function bar(share) {
  const fill = h('div', { class: 'bar' });
  fill.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
  return h('div', { class: 'bar-track' }, fill);
}

function periodLabel(days) {
  return days === 365 ? 'за год' : `за ${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

function showBanner(message) {
  $('banner').textContent = message ?? '';
  $('banner').hidden = !message;
}

function describeError(error) {
  if (error.name === 'NotConnectedError') return error.message;
  if (error.code === VK_ERROR.PERMISSION || error.code === VK_ERROR.ACCESS_DENIED) {
    return error.method === 'groups.get'
      ? 'VK не разрешил получить список сообществ. Вставьте ссылки на сообщества в настройках.'
      : 'VK не разрешил этому приложению читать стены. Новым приложениям VK ID часть прав выдают по согласованию: напишите на devsupport@corp.vk.com или вставьте в настройках другой ключ доступа.';
  }
  if (error.code === VK_ERROR.AUTH) return 'Ключ доступа недействителен. Войдите заново в настройках.';
  if (error.code === VK_ERROR.CAPTCHA) return 'VK запросил капчу, загрузка остановлена. Откройте vk.com, подождите немного и обновите данные.';
  if (error.code === VK_ERROR.RATE_LIMIT) return 'VK временно ограничил запросы, загрузка остановлена. Обновите данные позже.';
  if (error instanceof TypeError) return 'Нет связи с VK. Проверьте интернет и обновите данные.';
  return `Ошибка VK: ${error.message}`;
}

function renderSummary(stats) {
  if (!state.cache) {
    $('hero').textContent = 'Просмотры сообществ';
    $('subhero').textContent = '';
    return;
  }
  const views = stats.totalViews;
  $('hero').textContent = `${formatNumber(views)} ${plural(views, 'просмотр', 'просмотра', 'просмотров')} ${periodLabel(state.days)}`;
  const groups = stats.groups.length;
  const income = stats.hasPlacements
    ? ` AdBlogger: заработано ${formatMoney(stats.adEarned)}, прогноз ${formatMoney(stats.adForecast)}.`
    : '';
  $('subhero').textContent = `${formatNumber(stats.totalPosts)} ${plural(stats.totalPosts, 'пост', 'поста', 'постов')} в ${groups} ${plural(groups, 'сообществе', 'сообществах', 'сообществах')}. Данные на ${dateTimeFormat.format(state.cache.loadedAt * 1000)}.${income}`;
}

function renderAdblogger(stats) {
  const cabinetLink = h('a', { href: CABINET_URL, target: '_blank', rel: 'noreferrer' }, 'кабинет AdBlogger');
  if (state.adblogger?.formatError) {
    $('ad-status').replaceChildren('Не удалось прочитать данные AdBlogger: похоже, кабинет изменился. Показаны последние сохранённые данные, просмотры это не затрагивает.');
  } else if (stats.hasPlacements) {
    $('ad-status').replaceChildren(`AdBlogger: данные на ${dateTimeFormat.format(state.adblogger.updatedAt * 1000)}. Чтобы обновить, откройте `, cabinetLink, '.');
  } else {
    $('ad-status').replaceChildren('Чтобы увидеть доход по постам, откройте ', cabinetLink, ' в этом браузере.');
  }

  const placementTitle = (item) => [item.communityTitle, item.product].filter(Boolean).join(': ');
  $('ad-pending').hidden = !stats.pending.length;
  $('ad-pending-title').textContent = `Ещё не вышли: ${stats.pending.length}`;
  $('ad-pending-list').replaceChildren(...stats.pending.map((item) => {
    const status = AD_STATUS_LABELS[item.statusCode] ?? 'В работе';
    const deadline = item.expiresAt ? `, до ${dateFormat.format(Date.parse(item.expiresAt))}` : '';
    return h('li', {}, h('span', {}, placementTitle(item)), h('span', {}, status + deadline));
  }));

  $('ad-unmatched').hidden = !stats.unmatched.length;
  $('ad-unmatched-title').textContent = `Не нашлись среди постов: ${stats.unmatched.length}`;
  $('ad-unmatched-list').replaceChildren(...stats.unmatched.map((item) => h('li', {},
    h('a', { href: `https://vk.com/wall${item.postKey}`, target: '_blank', rel: 'noreferrer' }, placementTitle(item)),
    h('span', {}, `заработано ${formatMoney(item.earnedRub)}`))));
}

function renderGroups(stats) {
  const max = Math.max(1, ...stats.groups.map((group) => group.totalViews));
  const errors = state.cache?.errors ?? {};
  const selectGroup = (groupId) => () => {
    state.groupId = groupId;
    state.limit = PAGE_SIZE;
    render();
  };

  const allRow = h('li', {}, h('button', {
    type: 'button', class: 'group', 'aria-pressed': String(state.groupId === null), onclick: selectGroup(null),
  },
  h('span', { class: 'avatar' }),
  h('span', { class: 'group-name' }, 'Все сообщества'),
  h('span', { class: 'group-views' }, formatNumber(stats.totalViews)),
  h('span', { class: 'group-meta' }, `${formatNumber(stats.totalPosts)} ${plural(stats.totalPosts, 'пост', 'поста', 'постов')}`)));

  const rows = stats.groups.map((group) => {
    const meta = [
      `${group.postCount} ${plural(group.postCount, 'пост', 'поста', 'постов')}`,
      group.baseline === null ? null : `типичный ${formatNumber(group.baseline)}`,
      group.adEarned > 0 ? `заработано ${formatMoney(group.adEarned)}` : null,
    ].filter(Boolean).join(', ');
    const photo = group.photo?.startsWith('https://')
      ? h('img', { src: group.photo, alt: '', loading: 'lazy' })
      : h('span', { class: 'avatar' });
    return h('li', {}, h('button', {
      type: 'button', class: 'group', 'aria-pressed': String(state.groupId === group.id), onclick: selectGroup(group.id),
    },
    photo,
    h('span', { class: 'group-name', title: group.name }, group.name),
    h('span', { class: 'group-views' }, formatNumber(group.totalViews)),
    h('span', { class: 'group-meta' }, meta),
    h('span', { class: 'group-bar' }, bar(group.totalViews / max)),
    errors[group.id] ? h('span', { class: 'group-error' }, `Не обновилось: ${errors[group.id]}`) : null));
  });
  $('group-list').replaceChildren(allRow, ...rows);
}

function tableColumns(showAd) {
  return showAd
    ? [...COLUMNS.slice(0, COLUMNS_BEFORE_AD), ...AD_COLUMNS, ...COLUMNS.slice(COLUMNS_BEFORE_AD)]
    : COLUMNS;
}

function renderTableHead(showAd) {
  const cells = tableColumns(showAd).map((column) => {
    const active = column.key === state.sortKey;
    const label = column.key
      ? h('button', {
        type: 'button',
        title: column.title,
        onclick: () => {
          if (active) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
          else { state.sortKey = column.key; state.sortDir = 'desc'; }
          state.limit = PAGE_SIZE;
          render();
        },
      }, column.label + (active ? (state.sortDir === 'desc' ? ' ↓' : ' ↑') : ''))
      : column.label;
    return h('th', {
      scope: 'col',
      class: `col-${column.key ?? 'post'}${column.left ? ' left' : ''}`,
      'aria-sort': active ? (state.sortDir === 'desc' ? 'descending' : 'ascending') : null,
    }, label);
  });
  $('table-head').replaceChildren(...cells);
}

function postRow(post, maxViews, showAd) {
  const tags = [post.pinned && 'закреплён', post.ads && 'реклама', post.repost && 'репост'].filter(Boolean);
  const meta = [post.groupName, ...tags].join(', ');
  const adInfo = post.ad
    ? h('div', { class: 'post-meta' }, `AdBlogger: ${post.ad.product}, ${moneyFormat.format(post.ad.ratePercent)}%`)
    : null;
  const adCells = showAd
    ? [
      h('td', { class: 'money-cell' }, formatMoney(post.adEarned)),
      h('td', {}, formatMoney(post.adPerMille)),
      h('td', {}, formatMoney(post.adForecast)),
      h('td', {}, post.adClicks === null ? '—' : formatNumber(post.adClicks)),
    ]
    : [];
  const row = h('tr', {},
    h('td', { class: 'post-cell' },
      h('a', {
        class: 'post-text',
        href: `https://vk.com/wall${post.ownerId}_${post.id}`,
        target: '_blank',
        rel: 'noreferrer',
      }, post.text || post.kind || 'Пост без текста'),
      h('div', { class: 'post-meta' },
        h('span', { class: 'compact-date' }, `${dateFormat.format(post.date * 1000)} · `), meta),
      adInfo),
    h('td', { class: 'muted' }, dateFormat.format(post.date * 1000)),
    h('td', { class: 'views-cell' },
      post.views === null ? '—' : formatNumber(post.views),
      post.views === null ? null : bar(post.views / maxViews)),
    ...adCells,
    h('td', { title: post.score === null ? 'Нельзя сравнить: пост свежий или в сообществе мало постов' : null },
      post.score === null ? '—' : `×${scoreFormat.format(post.score)}`),
    h('td', {}, formatNumber(post.likes)),
    h('td', {}, formatNumber(post.reposts)),
    h('td', {}, formatNumber(post.comments)));
  tableColumns(showAd).forEach((column, index) => {
    row.children[index].classList.add(`col-${column.key ?? 'post'}`);
    row.children[index].setAttribute('data-label', column.label);
  });
  return row;
}

// Карточки для телефона

function shortTitle(post) {
  const words = post.text.split(/\s+/).filter(Boolean);
  if (!words.length) return post.kind || 'Пост без текста';
  return words.length > TITLE_WORDS ? `${words.slice(0, TITLE_WORDS).join(' ')}…` : words.join(' ');
}

function relativeDate(unixSeconds) {
  const date = new Date(unixSeconds * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return `сегодня в ${timeFormat.format(date)}`;
  if (date.toDateString() === yesterday.toDateString()) return `вчера в ${timeFormat.format(date)}`;
  return longDateFormat.format(date);
}

function scoreCaption(post) {
  if (post.views === null) return 'не сравнить';
  if (post.score === null) {
    return Date.now() / 1000 - post.date < MATURE_AGE_SEC ? 'свежий, ещё набирает' : 'мало постов для сравнения';
  }
  return post.score >= 1 ? 'выше обычного' : 'ниже обычного';
}

function adStub(post) {
  const { ad } = post;
  const earned = ad.earnedRub > 0;
  return h('div', { class: 'pc-stub' },
    h('div', { class: 'pc-ad-heading' },
      h('span', { class: 'pc-ad-label' }, 'AdBlogger'),
      h('span', { class: 'pc-rate' }, `${moneyFormat.format(ad.ratePercent)}% с продажи`)),
    h('div', { class: 'pc-product-row' },
      h('div', { class: 'pc-product-info' },
        h('div', { class: 'pc-product' }, ad.product || 'Товар без названия'),
        ad.priceRub > 0 ? h('div', { class: 'pc-product-price' }, `Цена товара ${formatMoney(ad.priceRub)}`) : null)),
    h('div', { class: earned ? 'pc-earned' : 'pc-earned zero' },
      formatMoney(ad.earnedRub),
      h('small', {}, earned ? 'заработано' : 'пока не заработано')),
    h('div', { class: 'pc-facts' },
      h('div', {}, h('b', {}, formatMoney(post.adPerMille)), h('span', {}, 'на 1000 просм.')),
      h('div', {}, h('b', {}, formatMoney(ad.forecastRub)), h('span', {}, 'прогноз')),
      h('div', {}, h('b', {}, formatNumber(ad.clicks)), h('span', {}, plural(ad.clicks, 'клик', 'клика', 'кликов')))));
}

function postCard(post, maxViews) {
  const tags = [post.pinned && 'закреплён', post.ads && 'реклама', post.repost && 'репост'].filter(Boolean);
  const card = h('a', {
    class: 'post-card',
    href: `https://vk.com/wall${post.ownerId}_${post.id}`,
    target: '_blank',
    rel: 'noreferrer',
  },
  h('div', { class: 'pc-post' },
    h('div', { class: 'pc-title', title: post.text || null }, shortTitle(post)),
    h('div', { class: 'pc-meta' }, [post.groupName, relativeDate(post.date), ...tags].join(', ')),
    h('div', { class: 'pc-numbers' },
      h('div', { class: 'pc-views' }, post.views === null ? '—' : formatNumber(post.views)),
      h('div', { class: post.score !== null && post.score >= 1 ? 'pc-score' : 'pc-score low' },
        post.score === null ? '—' : `×${scoreFormat.format(post.score)}`),
      h('small', {}, post.views === null ? 'VK не передал просмотры' : plural(post.views, 'просмотр', 'просмотра', 'просмотров')),
      h('small', { class: 'right' }, scoreCaption(post))),
    h('div', { class: 'pc-engage' }, [
      `${formatNumber(post.likes)} ${plural(post.likes, 'лайк', 'лайка', 'лайков')}`,
      `${formatNumber(post.reposts)} ${plural(post.reposts, 'репост', 'репоста', 'репостов')}`,
      `${formatNumber(post.comments)} ${plural(post.comments, 'комментарий', 'комментария', 'комментариев')}`,
    ].join(', '))),
  post.ad ? adStub(post) : null);
  card.style.setProperty('--share', `${post.views === null ? 0 : (post.views / maxViews) * 100}%`);
  return h('li', {}, card);
}

function renderMobileSelects(stats) {
  const groupSelect = $('group-select');
  // Сумма по всем уже есть в шапке, а в узком списке она не помещается.
  const groupOptions = [h('option', { value: '' }, 'Все сообщества'),
    ...stats.groups.map((group, index) => h('option', { value: String(index) }, `${group.name}: ${formatNumber(group.totalViews)}`))];
  groupSelect.replaceChildren(...groupOptions);
  const selectedIndex = stats.groups.findIndex((group) => group.id === state.groupId);
  groupSelect.value = selectedIndex === -1 ? '' : String(selectedIndex);
  groupSelect.onchange = () => {
    state.groupId = groupSelect.value === '' ? null : stats.groups[Number(groupSelect.value)].id;
    state.limit = PAGE_SIZE;
    render();
  };

  const sortSelect = $('sort-select');
  const sorts = MOBILE_SORTS.filter((sort) => !sort.adOnly || stats.hasPlacements);
  sortSelect.replaceChildren(...sorts.map((sort) => h('option', { value: `${sort.key}:${sort.dir}` }, sort.label)));
  // Порядок, выбранный в таблице на компьютере, может не совпасть со списком: тогда показываем первый пункт.
  const current = `${state.sortKey}:${state.sortDir}`;
  sortSelect.value = sorts.some((sort) => `${sort.key}:${sort.dir}` === current) ? current : sortSelect.options[0].value;
  sortSelect.onchange = () => {
    [state.sortKey, state.sortDir] = sortSelect.value.split(':');
    state.limit = PAGE_SIZE;
    render();
  };
}

function renderPosts(stats) {
  const posts = selectPosts(stats.posts, {
    groupId: state.groupId,
    query: state.query,
    sortKey: state.sortKey,
    sortDir: state.sortDir,
    onlyAd: state.onlyAd && stats.hasPlacements,
  });
  const showAd = stats.hasPlacements;
  const maxViews = Math.max(1, ...posts.map((post) => post.views ?? 0));
  const group = stats.groups.find((item) => item.id === state.groupId);
  $('posts-title').textContent = group ? group.name : 'Все посты';
  $('only-ad-label').hidden = !showAd;
  document.querySelector('.table-wrap').classList.toggle('has-ad', showAd);
  renderTableHead(showAd);
  const visible = posts.slice(0, state.limit);
  $('post-rows').replaceChildren(...visible.map((post) => postRow(post, maxViews, showAd)));
  // Таблица и карточки строятся обе, а показывает нужную CSS по ширине экрана.
  $('post-cards').replaceChildren(...visible.map((post) => postCard(post, maxViews)));
  renderMobileSelects(stats);
  $('show-more').hidden = posts.length <= state.limit;
  $('show-more').textContent = `Показать ещё (осталось ${formatNumber(posts.length - state.limit)})`;
  $('posts-empty').hidden = posts.length > 0;
  if (state.query.trim()) $('posts-empty').textContent = 'Нет постов с таким текстом. Измените запрос.';
  else if (state.onlyAd && showAd) $('posts-empty').textContent = `Нет постов AdBlogger ${periodLabel(state.days)}. Выберите период длиннее.`;
  else $('posts-empty').textContent = `Нет постов ${periodLabel(state.days)}. Выберите период длиннее.`;
}

function render() {
  const hasData = Boolean(state.cache);
  $('welcome').hidden = hasData || state.loading;
  $('board').hidden = !hasData;
  $('refresh').disabled = state.loading;
  document.querySelector('.controls').hidden = !hasData && !state.loading;
  $('load-adblogger').hidden = !hasData;
  $('load-adblogger').disabled = state.adLoading;
  $('load-adblogger').textContent = state.adLoading ? 'Загружаем AdBlogger…' : 'Загрузить AdBlogger';
  for (const button of document.querySelectorAll('.periods button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.days) === state.days));
  }
  const stats = hasData
    ? buildStats(state.cache.groups, state.cache.postsByGroup, state.days, Date.now() / 1000, state.adblogger?.items)
    : { groups: [], posts: [], totalViews: 0, totalPosts: 0, hasPlacements: false };
  renderSummary(stats);
  if (hasData) {
    renderGroups(stats);
    renderPosts(stats);
    renderAdblogger(stats);
  }
}

function showProgress({ done, total, groupName }) {
  $('progress').hidden = false;
  $('progress-bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('progress-text').textContent = groupName
    ? `Загружаем ${done + 1} из ${total}: ${groupName}`
    : 'Сохраняем';
}

async function refreshData() {
  if (state.loading) return;
  if (!state.connected) {
    openSettings();
    return;
  }
  state.loading = true;
  showBanner(null);
  $('progress').hidden = false;
  $('progress-bar').style.width = '0';
  $('progress-text').textContent = 'Получаем список сообществ';
  render();
  try {
    const client = createVkClient({ getToken: getAccessToken });
    const { domains } = parseGroupLinks((await getSettings()).groupLinks);
    const result = await loadAll({
      client, days: state.days, now: Date.now() / 1000, domains, previous: state.cache, onProgress: showProgress,
    });
    const { fatal, ...cache } = result;
    state.cache = cache;
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
    if (fatal) showBanner(describeError(fatal));
  } catch (error) {
    showBanner(describeError(error));
  } finally {
    state.connected = await isConnected();
    state.loading = false;
    $('progress').hidden = true;
    render();
  }
}

/** Ждёт, пока вкладка кабинета сохранит заявки. Возвращает 'saved', 'closed' или 'timeout'. */
function waitForCabinet(tabId) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(result);
    };
    const onStorage = (changes, area) => {
      if (area === 'local' && changes[ADBLOGGER_KEY]) finish('saved');
    };
    const onRemoved = (id) => {
      if (id === tabId) finish('closed');
    };
    const timer = setTimeout(() => finish('timeout'), CABINET_WAIT_MS);
    chrome.storage.onChanged.addListener(onStorage);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// Своего запроса к AdBlogger здесь нет: страница кабинета загружает заявки сама, а hook.js копирует ответ.
async function loadAdblogger() {
  if (state.adLoading) return;
  state.adLoading = true;
  showBanner(null);
  render();
  try {
    const tab = await chrome.tabs.create({ url: CABINET_URL, active: false });
    const result = await waitForCabinet(tab.id);
    if (result === 'saved') {
      await chrome.tabs.remove(tab.id).catch(() => {});
    } else if (result === 'timeout') {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      showBanner('Кабинет AdBlogger не передал заявки. Проверьте открытую вкладку: если нужно, войдите, и данные появятся здесь сами.');
    } else {
      showBanner('Загрузка AdBlogger отменена: вкладка кабинета закрыта.');
    }
  } catch (error) {
    showBanner(`Не удалось открыть кабинет AdBlogger: ${error.message}`);
  } finally {
    state.adLoading = false;
    render();
  }
}

function saveView() {
  chrome.storage.local.set({ [VIEW_KEY]: { days: state.days } });
}

// Настройки

// VK отклоняет запрос прав сверх разрешённых приложению, поэтому просим только то, что нужно.
function requiredScope(domains) {
  return domains.length ? 'wall' : 'groups wall';
}

/** Проверяет поле со ссылками. Возвращает их или null, если показана ошибка. */
function readGroupLinks() {
  const text = $('group-links').value;
  const { domains, invalid } = parseGroupLinks(text);
  if (invalid.length) {
    showSettingsError(`Это не ссылки на сообщества VK: ${invalid.join(', ')}. Исправьте или удалите их.`);
    return null;
  }
  return { text, domains };
}

async function onSaveLinks() {
  const links = readGroupLinks();
  if (!links) return;
  showSettingsError(null);
  await saveSettings({ groupLinks: links.text });
  state.groupId = null;
  $('settings').close();
  if (state.connected) await refreshData();
}

async function renderConnectionStatus() {
  if (!state.connected) {
    $('connection-status').textContent = 'Аккаунт не подключён.';
    return;
  }
  const scope = await getGrantedScope();
  const { groupLinks } = await getSettings();
  const required = requiredScope(parseGroupLinks(groupLinks).domains).split(' ');
  const missing = scope === null ? [] : required.filter((name) => !scope.split(' ').includes(name));
  $('connection-status').textContent = missing.length
    ? `Аккаунт подключён, но VK не выдал права: ${missing.join(', ')}.`
    : 'Аккаунт подключён.';
}

async function openSettings() {
  const settings = await getSettings();
  $('client-id').value = settings.clientId;
  $('redirect-uri').value = settings.redirectUri;
  $('group-links').value = settings.groupLinks;
  $('manual-token').value = '';
  showSettingsError(null);
  await renderConnectionStatus();
  $('settings').showModal();
}

function showSettingsError(message) {
  $('settings-error').textContent = message ?? '';
  $('settings-error').hidden = !message;
}

async function afterConnect() {
  state.connected = true;
  $('settings').close();
  await refreshData();
}

async function onLogin() {
  const clientId = $('client-id').value.trim();
  const redirectUri = $('redirect-uri').value.trim();
  if (!/^\d+$/.test(clientId)) {
    showSettingsError('Укажите ID приложения: только цифры.');
    return;
  }
  if (!redirectUri.startsWith('https://')) {
    showSettingsError('Адрес перенаправления должен начинаться с https://.');
    return;
  }
  const links = readGroupLinks();
  if (!links) return;
  showSettingsError(null);
  await saveSettings({ clientId, redirectUri, groupLinks: links.text });
  $('login').disabled = true;
  try {
    await login({ clientId, redirectUri, scope: requiredScope(links.domains) });
    await afterConnect();
  } catch (error) {
    showSettingsError(`Вход не выполнен: ${error.message}`);
  } finally {
    $('login').disabled = false;
  }
}

async function onSaveToken() {
  const token = $('manual-token').value.trim();
  if (!token) {
    showSettingsError('Вставьте ключ доступа.');
    return;
  }
  const links = readGroupLinks();
  if (!links) return;
  await saveSettings({ groupLinks: links.text });
  await setManualToken(token);
  $('manual-token').value = '';
  await afterConnect();
}

async function onLogout() {
  await logout();
  await chrome.storage.local.remove(CACHE_KEY);
  await chrome.storage.local.remove(ADBLOGGER_KEY);
  state.connected = false;
  state.cache = null;
  state.adblogger = null;
  state.groupId = null;
  showBanner(null);
  $('settings').close();
  render();
}

function bindEvents() {
  for (const button of document.querySelectorAll('.periods button')) {
    button.addEventListener('click', () => {
      state.days = Number(button.dataset.days);
      state.limit = PAGE_SIZE;
      saveView();
      render();
      // Для более длинного периода постов в кеше не хватает, поэтому догружаем их.
      if (state.cache && state.connected && state.days > state.cache.loadedDays) refreshData();
    });
  }
  $('refresh').addEventListener('click', refreshData);
  $('load-adblogger').addEventListener('click', loadAdblogger);
  $('open-settings').addEventListener('click', openSettings);
  $('welcome-settings').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', () => $('settings').close());
  $('login').addEventListener('click', onLogin);
  $('save-token').addEventListener('click', onSaveToken);
  $('save-links').addEventListener('click', onSaveLinks);
  $('logout').addEventListener('click', onLogout);
  $('settings-form').addEventListener('submit', (event) => event.preventDefault());
  $('search').addEventListener('input', (event) => {
    state.query = event.target.value;
    state.limit = PAGE_SIZE;
    render();
  });
  $('show-more').addEventListener('click', () => {
    state.limit += PAGE_SIZE;
    render();
  });
  $('only-ad').addEventListener('change', (event) => {
    state.onlyAd = event.target.checked;
    state.limit = PAGE_SIZE;
    render();
  });
  // Кабинет может быть открыт рядом: новые заявки появляются в дашборде сразу.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ADBLOGGER_KEY]) return;
    state.adblogger = changes[ADBLOGGER_KEY].newValue ?? null;
    render();
  });
}

async function init() {
  bindEvents();
  const stored = await chrome.storage.local.get([CACHE_KEY, VIEW_KEY, ADBLOGGER_KEY]);
  state.cache = stored[CACHE_KEY] ?? null;
  state.adblogger = stored[ADBLOGGER_KEY] ?? null;
  state.days = stored[VIEW_KEY]?.days ?? state.days;
  state.connected = await isConnected();
  render();
  if (state.connected && !state.cache) await refreshData();
}

init();
