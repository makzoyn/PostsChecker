// Чистая логика статистики: без браузерных API, поэтому легко тестируется.

const DAY_SEC = 86_400;
const TEXT_LIMIT = 280;

// Свежий пост ещё набирает просмотры, поэтому сравнивать его с остальными нечестно.
export const MATURE_AGE_SEC = 2 * DAY_SEC;
export const MIN_BASELINE_POSTS = 3;

const ATTACHMENT_LABELS = {
  photo: 'Фото',
  video: 'Видео',
  audio: 'Аудио',
  doc: 'Файл',
  link: 'Ссылка',
  poll: 'Опрос',
  market: 'Товар',
};

export function trimPost(raw) {
  const attachment = raw.attachments?.[0]?.type;
  return {
    id: raw.id,
    ownerId: raw.owner_id,
    date: raw.date,
    text: (raw.text ?? '').slice(0, TEXT_LIMIT),
    kind: ATTACHMENT_LABELS[attachment] ?? null,
    // У части записей поля views нет: это «нет данных», а не ноль просмотров.
    views: raw.views?.count ?? null,
    likes: raw.likes?.count ?? 0,
    reposts: raw.reposts?.count ?? 0,
    comments: raw.comments?.count ?? 0,
    pinned: Boolean(raw.is_pinned),
    ads: Boolean(raw.marked_as_ads),
    repost: Boolean(raw.copy_history?.length),
  };
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Типичные просмотры сообщества: медиана только по постам, которые успели набрать просмотры. */
export function baselineViews(posts, now) {
  const mature = posts
    .filter((post) => post.views !== null && now - post.date >= MATURE_AGE_SEC)
    .map((post) => post.views);
  return mature.length >= MIN_BASELINE_POSTS ? median(mature) : null;
}

/** Во сколько раз пост обогнал типичный пост своего сообщества. null, если сравнивать нечестно. */
export function postPerformance(post, baseline, now) {
  if (post.views === null || !baseline || now - post.date < MATURE_AGE_SEC) return null;
  return post.views / baseline;
}

const MILLE = 1000;

function adFields(placement, views) {
  return {
    ad: placement ?? null,
    adClicks: placement ? placement.clicks : null,
    adForecast: placement ? placement.forecastRub : null,
    adEarned: placement ? placement.earnedRub : null,
    // Без просмотров показатель не имеет смысла, и деления на ноль быть не должно.
    adPerMille: placement && views ? (placement.earnedRub / views) * MILLE : null,
  };
}

/** Заявки, которых ещё нет на стене, ближайшие по сроку сначала. Просроченные не показываем. */
function pendingPlacements(placements, now) {
  return placements
    .filter((item) => !item.postKey && (!item.expiresAt || Date.parse(item.expiresAt) / 1000 >= now))
    .sort((a, b) => (Date.parse(a.expiresAt) || Infinity) - (Date.parse(b.expiresAt) || Infinity));
}

export function buildStats(groups, postsByGroup, days, now, placementsByNumber = {}) {
  const cutoff = now - days * DAY_SEC;
  const rows = [];
  const placements = Object.values(placementsByNumber);
  const byPostKey = new Map(placements.filter((item) => item.postKey).map((item) => [item.postKey, item]));
  const matched = new Set();
  const groupRows = groups.map((group) => {
    const posts = (postsByGroup[group.id] ?? []).filter((post) => post.date >= cutoff);
    const baseline = baselineViews(posts, now);
    let totalViews = 0;
    let adEarned = 0;
    for (const post of posts) {
      totalViews += post.views ?? 0;
      const key = `${post.ownerId}_${post.id}`;
      const placement = byPostKey.get(key);
      if (placement) {
        matched.add(key);
        adEarned += placement.earnedRub;
      }
      rows.push({
        ...post,
        groupId: group.id,
        groupName: group.name,
        score: postPerformance(post, baseline, now),
        ...adFields(placement, post.views),
      });
    }
    return { ...group, totalViews, postCount: posts.length, baseline, adEarned };
  });
  groupRows.sort((a, b) => b.totalViews - a.totalViews);
  const adRows = rows.filter((row) => row.ad);
  return {
    groups: groupRows,
    posts: rows,
    totalViews: groupRows.reduce((sum, group) => sum + group.totalViews, 0),
    totalPosts: rows.length,
    hasPlacements: placements.length > 0,
    adEarned: adRows.reduce((sum, row) => sum + row.adEarned, 0),
    adForecast: adRows.reduce((sum, row) => sum + row.adForecast, 0),
    pending: pendingPlacements(placements, now),
    // Вышли за этот период, но поста нет в таблице: сообщество не в списке, стена не прочиталась или пост удалён.
    unmatched: placements.filter((item) => item.postKey
      && !matched.has(item.postKey)
      && Date.parse(item.publishedAt) / 1000 >= cutoff),
  };
}

export function selectPosts(posts, {
  groupId = null, query = '', sortKey = 'views', sortDir = 'desc', onlyAd = false,
} = {}) {
  const needle = query.trim().toLowerCase();
  const selected = posts.filter((post) => (
    (groupId === null || post.groupId === groupId)
    && (!needle || post.text.toLowerCase().includes(needle))
    && (!onlyAd || post.ad)
  ));
  const direction = sortDir === 'asc' ? 1 : -1;
  return selected.sort((a, b) => {
    const left = a[sortKey];
    const right = b[sortKey];
    // Посты без данных всегда внизу, в каком бы порядке ни шла сортировка.
    if (left === null && right === null) return b.date - a.date;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * direction || b.date - a.date;
  });
}
