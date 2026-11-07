// Выполняется в контексте страницы кабинета до её собственного кода.
// Кабинет запоминает window.fetch при запуске, поэтому оборачивать его нужно раньше (document_start).
// Запросов скрипт не отправляет: он только копирует ответ, который страница получила сама.
(() => {
  const PLACEMENTS_PATH = '/api/v1/author/soco/placements';
  const SOURCE = 'vk-views-adblogger';
  const originalFetch = window.fetch;

  function isPlacementsRequest(input) {
    try {
      const url = typeof input === 'object' && input !== null && 'url' in input ? input.url : input;
      return new URL(String(url), location.href).pathname === PLACEMENTS_PATH;
    } catch {
      return false;
    }
  }

  // Только нужные поля: тексты постов, токены маркировки и контакты дальше страницы не уходят.
  function pick(raw) {
    return {
      number: raw?.number,
      publishedUrl: raw?.publishedUrl,
      publishDateTime: raw?.publishDateTime,
      sum100: raw?.sum100,
      status: { code: raw?.status?.code, expiresAt: raw?.status?.expiresAt },
      stats: {
        clickCount: raw?.stats?.clickCount,
        cpm100: raw?.stats?.cpm100,
        predictedReward: raw?.stats?.predictedReward,
      },
      product: {
        name: raw?.product?.name,
        price100: raw?.product?.price100,
        rate1000: raw?.product?.rate1000,
      },
      community: { title: raw?.community?.title, link: raw?.community?.link },
    };
  }

  function publish(data) {
    const message = Array.isArray(data?.items)
      ? { source: SOURCE, items: data.items.map(pick) }
      : { source: SOURCE, formatError: true };
    window.postMessage(message, location.origin);
  }

  window.fetch = function fetchWithCopy(...args) {
    const result = originalFetch.apply(this, args);
    if (isPlacementsRequest(args[0])) {
      // Ошибки здесь не должны влиять на кабинет: страница получает тот же ответ, что и без расширения.
      result.then((response) => {
        if (!response.ok) return;
        response.clone().json().then(publish, () => publish(null));
      }, () => {});
    }
    return result;
  };
})();
