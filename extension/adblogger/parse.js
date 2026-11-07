// Разбор заявок AdBlogger. Обычный скрипт, потому что контент-скрипты не бывают модулями.
globalThis.VkViewsAdblogger = (() => {
  // Поля с суффиксом 100 хранятся в копейках: price100 = 13700 в кабинете показан как 137 ₽.
  // Для sum100 и cpm100 это пока допущение, реальные ненулевые значения не сверялись.
  // predictedReward приходит в рублях: сверено с колонкой «Прогноз дохода» (56,00 ₽).
  const KOPECKS_IN_RUBLE = 100;
  const RATE_DIVIDER = 1000;
  const WALL_URL = /^https:\/\/(?:[a-z]+\.)?vk\.(?:com|ru)\/wall(-\d+_\d+)(?:[/?#]|$)/i;
  const VK_LINK = /^https:\/\/(?:[a-z]+\.)?vk\.(?:com|ru)\//i;

  const toNumber = (value) => (Number.isFinite(value) ? value : 0);
  const toText = (value) => (typeof value === 'string' ? value : '');

  /** Адрес поста в виде ключа, общего с VK API: -100500_37. */
  function postKey(url) {
    return toText(url).match(WALL_URL)?.[1] ?? null;
  }

  function normalizePlacement(raw) {
    const number = toText(raw?.number);
    if (!number) return null;
    const link = toText(raw.community?.link);
    return {
      number,
      postKey: postKey(raw.publishedUrl),
      publishedAt: toText(raw.publishDateTime) || null,
      statusCode: toText(raw.status?.code),
      expiresAt: toText(raw.status?.expiresAt) || null,
      product: toText(raw.product?.name),
      priceRub: toNumber(raw.product?.price100) / KOPECKS_IN_RUBLE,
      ratePercent: toNumber(raw.product?.rate1000) / RATE_DIVIDER,
      clicks: toNumber(raw.stats?.clickCount),
      cpmRub: toNumber(raw.stats?.cpm100) / KOPECKS_IN_RUBLE,
      forecastRub: toNumber(raw.stats?.predictedReward),
      earnedRub: toNumber(raw.sum100) / KOPECKS_IN_RUBLE,
      communityTitle: toText(raw.community?.title),
      communityLink: VK_LINK.test(link) ? link : null,
    };
  }

  /**
   * Дописывает заявки к сохранённым, а не заменяет их: ответ содержит только то,
   * что выбрано фильтром кабинета, и остальные заявки не должны пропасть.
   */
  function mergePlacements(state, rawItems, now) {
    const items = { ...(state?.items ?? {}) };
    for (const raw of rawItems) {
      const placement = normalizePlacement(raw);
      if (placement) items[placement.number] = placement;
    }
    return { items, updatedAt: now, formatError: false };
  }

  return { mergePlacements, normalizePlacement, postKey };
})();
