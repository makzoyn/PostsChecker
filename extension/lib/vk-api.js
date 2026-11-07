// Клиент VK API. Лимит ключа пользователя по документации: 3 запроса в секунду.

const API_BASE = 'https://api.vk.ru/method/';
const API_VERSION = '5.131';
const MIN_INTERVAL_MS = 350;
const MAX_RATE_RETRIES = 3;

export const VK_ERROR = {
  AUTH: 5,
  TOO_MANY_REQUESTS: 6,
  PERMISSION: 7,
  CAPTCHA: 14,
  ACCESS_DENIED: 15,
  RATE_LIMIT: 29,
};

export class VkApiError extends Error {
  constructor(code, message, method) {
    super(message);
    this.name = 'VkApiError';
    this.code = code;
    this.method = method;
  }

  /** Ошибки, при которых продолжать запросы к другим сообществам бессмысленно. */
  get stopsLoading() {
    return this.code === VK_ERROR.AUTH || this.code === VK_ERROR.CAPTCHA || this.code === VK_ERROR.RATE_LIMIT;
  }
}

export function createVkClient({
  getToken,
  fetchFn = (...args) => fetch(...args),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = MIN_INTERVAL_MS,
}) {
  let queue = Promise.resolve();

  // Запросы идут строго по очереди с паузой, поэтому лимит соблюдается при любом числе вызовов.
  function throttled(task) {
    const run = queue.then(task);
    queue = run.catch(() => {}).then(() => sleep(minIntervalMs));
    return run;
  }

  async function send(method, params, token) {
    const response = await fetchFn(API_BASE + method, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ ...params, v: API_VERSION }),
    });
    const data = await response.json();
    if (data.error) throw new VkApiError(data.error.error_code, data.error.error_msg, method);
    return data.response;
  }

  async function call(method, params = {}) {
    let token = await getToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await throttled(() => send(method, params, token));
      } catch (error) {
        if (error.code === VK_ERROR.TOO_MANY_REQUESTS && attempt < MAX_RATE_RETRIES) {
          await sleep(1000 * 2 ** attempt);
        } else if (error.code === VK_ERROR.AUTH && !refreshed) {
          refreshed = true;
          token = await getToken({ rejectedToken: token });
        } else {
          throw error;
        }
      }
    }
  }

  return { call };
}
