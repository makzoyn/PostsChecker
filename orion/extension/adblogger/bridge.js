// Контент-скрипт: принимает заявки от hook.js, сохраняет их и показывает короткую подпись на странице.
(() => {
  const SOURCE = 'vk-views-adblogger';
  const STORAGE_KEY = 'adblogger';
  const BADGE_ID = 'vk-views-adblogger-badge';
  const BADGE_MS = 6000;
  const { mergePlacements } = globalThis.VkViewsAdblogger;

  let badgeTimer = null;
  // Записи идут по очереди: иначе два быстрых ответа могли бы затереть друг друга.
  let queue = Promise.resolve();

  function showBadge(text) {
    let badge = document.getElementById(BADGE_ID);
    if (!badge) {
      badge = document.createElement('div');
      badge.id = BADGE_ID;
      badge.setAttribute('role', 'status');
      Object.assign(badge.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483647',
        padding: '8px 12px',
        borderRadius: '6px',
        background: '#191b2c',
        color: '#ffffff',
        font: '13px/1.4 system-ui, sans-serif',
      });
      document.documentElement.append(badge);
    }
    badge.textContent = text;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => badge.remove(), BADGE_MS);
  }

  async function save(message) {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    const now = Date.now() / 1000;
    if (message.formatError) {
      await chrome.storage.local.set({ [STORAGE_KEY]: { ...stored, formatError: true } });
      showBadge('Просмотры сообществ VK: не удалось прочитать данные AdBlogger');
      return;
    }
    const next = mergePlacements(stored, message.items, now);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    showBadge(`Просмотры сообществ VK: сохранено заявок: ${Object.keys(next.items).length}`);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.source !== SOURCE) return;
    if (!message.formatError && !Array.isArray(message.items)) return;
    // После обновления расширения старый скрипт теряет доступ к хранилищу, кабинету это не должно мешать.
    queue = queue.then(() => save(message)).catch(() => {});
  });
})();
