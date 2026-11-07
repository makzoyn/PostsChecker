// Загрузка сообществ и постов через VK API.
import { trimPost } from './stats.js';

const DAY_SEC = 86_400;
const PAGE_GROUPS = 1000;
const PAGE_POSTS = 100;

export async function fetchGroups(client) {
  const groups = [];
  for (let offset = 0; ; offset += PAGE_GROUPS) {
    const page = await client.call('groups.get', {
      // По документации moder включает администраторов, редакторов и модераторов.
      filter: 'moder',
      extended: 1,
      fields: 'members_count',
      count: PAGE_GROUPS,
      offset,
    });
    groups.push(...page.items);
    if (!page.items.length || groups.length >= page.count) break;
  }
  return groups.map(toGroup);
}

const PAGE_RESOLVE = 500;

function toGroup(group) {
  return {
    id: group.id,
    name: group.name,
    screenName: group.screen_name,
    photo: group.photo_50 ?? null,
    members: group.members_count ?? null,
  };
}

function matchesDomain(group, domain) {
  const name = domain.toLowerCase();
  return group.screen_name?.toLowerCase() === name
    || ['club', 'public', 'event'].some((prefix) => `${prefix}${group.id}` === name);
}

/**
 * Находит названия и аватары сообществ по ссылкам. Эти данные только для отображения:
 * сообщество, которое не удалось определить, всё равно попробуем прочитать по его имени.
 */
export async function resolveGroups(client, domains) {
  const found = [];
  for (let start = 0; start < domains.length; start += PAGE_RESOLVE) {
    try {
      const response = await client.call('groups.getById', {
        group_ids: domains.slice(start, start + PAGE_RESOLVE).join(','),
        fields: 'members_count',
      });
      // В новых версиях API список лежит в поле groups, в старых это сам ответ.
      found.push(...(response.groups ?? response));
    } catch (error) {
      if (error.stopsLoading || error.name === 'NotConnectedError') throw error;
    }
  }
  return domains.map((domain) => {
    const group = found.find((item) => matchesDomain(item, domain));
    return group
      ? { ...toGroup(group), screenName: domain }
      : { id: domain, name: domain, screenName: domain, photo: null, members: null };
  });
}

export async function fetchWall(client, group, days, now) {
  const cutoff = now - days * DAY_SEC;
  const posts = new Map();
  for (let offset = 0; ; offset += PAGE_POSTS) {
    const page = await client.call('wall.get', {
      domain: group.screenName,
      count: PAGE_POSTS,
      offset,
    });
    let reachedOld = false;
    for (const raw of page.items) {
      // Новый пост во время загрузки сдвигает страницы, поэтому записи могут повториться: Map их схлопнет.
      if (raw.date >= cutoff) posts.set(raw.id, trimPost(raw));
      // Закреплённый пост идёт первым даже если он старый, по нему останавливаться нельзя.
      else if (!raw.is_pinned) reachedOld = true;
    }
    if (reachedOld || !page.items.length || offset + page.items.length >= page.count) break;
  }
  return [...posts.values()];
}

/** Ошибка одного сообщества не мешает остальным. Для него остаются ранее сохранённые посты. */
export async function loadAll({ client, days, now, domains = [], previous = null, onProgress = () => {} }) {
  // Список пользователя важнее автоматического: для него не нужно право groups.
  const groups = domains.length ? await resolveGroups(client, domains) : await fetchGroups(client);
  const postsByGroup = {};
  const errors = {};
  let fatal = null;

  for (const [index, group] of groups.entries()) {
    onProgress({ done: index, total: groups.length, groupName: group.name });
    if (fatal) {
      postsByGroup[group.id] = previous?.postsByGroup?.[group.id] ?? [];
      continue;
    }
    try {
      postsByGroup[group.id] = await fetchWall(client, group, days, now);
    } catch (error) {
      postsByGroup[group.id] = previous?.postsByGroup?.[group.id] ?? [];
      if (error.stopsLoading || error.name === 'NotConnectedError') fatal = error;
      else errors[group.id] = error.message;
    }
  }
  onProgress({ done: groups.length, total: groups.length, groupName: null });

  return {
    groups,
    postsByGroup,
    errors,
    fatal,
    // При прерванной загрузке глубина старых данных не изменилась.
    loadedDays: fatal ? (previous?.loadedDays ?? 0) : days,
    loadedAt: now,
  };
}
