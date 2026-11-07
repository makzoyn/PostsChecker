// Вход через VK ID (OAuth 2.1 + PKCE) и хранение токенов.
// Документация: https://id.vk.ru/about/business/go/docs/ru/vkid/latest/vk-id/connection/api-description

const AUTHORIZE_URL = 'https://id.vk.ru/authorize';
const TOKEN_URL = 'https://id.vk.ru/oauth2/auth';
const AUTH_KEY = 'auth';
const SETTINGS_KEY = 'settings';
const REFRESH_MARGIN_MS = 60_000;

export class NotConnectedError extends Error {
  constructor(message = 'Войдите через VK ID в настройках.') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Разбирает адрес перенаправления. Возвращает null, если это ещё не он. */
export function parseRedirect(url, redirectUri, expectedState) {
  if (!url || !url.startsWith(redirectUri)) return null;
  const params = new URL(url).searchParams;
  if (params.get('error')) {
    throw new Error(params.get('error_description') || params.get('error'));
  }
  if (params.get('state') !== expectedState) {
    throw new Error('VK вернул неверный параметр state. Войдите ещё раз.');
  }
  const code = params.get('code');
  const deviceId = params.get('device_id');
  if (!code || !deviceId) throw new Error('VK не вернул код подтверждения. Войдите ещё раз.');
  return { code, deviceId };
}

export function defaultRedirectUri() {
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
}

export async function getSettings() {
  const { [SETTINGS_KEY]: saved } = await chrome.storage.local.get(SETTINGS_KEY);
  return { clientId: '', redirectUri: defaultRedirectUri(), groupLinks: '', ...saved };
}

/** Сохраняет только переданные поля, остальные настройки не меняются. */
export async function saveSettings(changes) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...(await getSettings()), ...changes } });
}

async function readAuth() {
  const { [AUTH_KEY]: auth } = await chrome.storage.local.get(AUTH_KEY);
  return auth || null;
}

export async function isConnected() {
  return Boolean(await readAuth());
}

export async function getGrantedScope() {
  return (await readAuth())?.scope ?? null;
}

async function postToken(body) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await response.json();
  if (data.error) {
    const error = new Error(data.error_description || data.error);
    error.rejectedByServer = true;
    throw error;
  }
  if (data.state !== body.state) {
    throw new Error('VK вернул неверный параметр state при получении токена.');
  }
  return data;
}

async function storeTokens(data, clientId, deviceId) {
  const auth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    deviceId,
    clientId,
    scope: data.scope ?? '',
    expiresAt: data.expires_in > 0 ? Date.now() + data.expires_in * 1000 : null,
  };
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  return auth;
}

/** Открывает вход во вкладке и ждёт, пока VK перенаправит её на redirectUri. */
function waitForRedirect(authorizeUrl, redirectUri, state) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    const finish = (settle, value) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      settle(value);
    };
    const onUpdated = (id, change) => {
      if (id !== tabId || !change.url) return;
      try {
        const result = parseRedirect(change.url, redirectUri, state);
        if (!result) return;
        chrome.tabs.remove(tabId).catch(() => {});
        finish(resolve, result);
      } catch (error) {
        chrome.tabs.remove(tabId).catch(() => {});
        finish(reject, error);
      }
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(reject, new Error('Вход отменён: вкладка VK закрыта.'));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.create({ url: authorizeUrl }).then((tab) => { tabId = tab.id; }, (error) => finish(reject, error));
  });
}

export async function login({ clientId, redirectUri, scope }) {
  const verifier = randomString(48);
  const state = randomString(32);
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: 'S256',
    scope,
  });

  const { code, deviceId } = await waitForRedirect(url.toString(), redirectUri, state);
  const data = await postToken({
    grant_type: 'authorization_code',
    code_verifier: verifier,
    redirect_uri: redirectUri,
    code,
    client_id: clientId,
    device_id: deviceId,
    state,
  });
  return storeTokens(data, clientId, deviceId);
}

export async function setManualToken(token) {
  await chrome.storage.local.set({ [AUTH_KEY]: { accessToken: token.trim(), manual: true } });
}

export async function logout() {
  await chrome.storage.local.remove(AUTH_KEY);
}

async function refresh(auth) {
  try {
    const data = await postToken({
      grant_type: 'refresh_token',
      refresh_token: auth.refreshToken,
      client_id: auth.clientId,
      device_id: auth.deviceId,
      state: randomString(32),
    });
    return await storeTokens(data, auth.clientId, auth.deviceId);
  } catch (error) {
    // Сбой сети не должен стирать рабочий refresh-токен: удаляем только то, что отверг сервер.
    if (error.rejectedByServer) {
      await logout();
      throw new NotConnectedError('Срок входа истёк. Войдите через VK ID ещё раз.');
    }
    throw error;
  }
}

/**
 * Возвращает действующий ключ доступа. Обновление идёт под блокировкой: VK ID отключает
 * старую пару токенов при обмене, поэтому две вкладки не должны обновлять её одновременно.
 * rejectedToken: ключ, который отверг API. Если другая вкладка уже заменила его, новый запрос к VK ID не нужен.
 */
export function getAccessToken({ rejectedToken = null } = {}) {
  return navigator.locks.request('vk-auth', async () => {
    const auth = await readAuth();
    if (!auth) throw new NotConnectedError();
    if (auth.manual) {
      if (rejectedToken === auth.accessToken) {
        throw new NotConnectedError('Ключ доступа недействителен или истёк. Вставьте новый в настройках.');
      }
      return auth.accessToken;
    }
    const rejected = rejectedToken === auth.accessToken;
    const fresh = auth.expiresAt === null || auth.expiresAt - REFRESH_MARGIN_MS > Date.now();
    if (fresh && !rejected) return auth.accessToken;
    return (await refresh(auth)).accessToken;
  });
}
