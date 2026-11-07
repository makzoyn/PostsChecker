// Разбор ссылок на сообщества, которые пользователь вставляет сам.

const VK_HOSTS = /^(?:[a-z]+\.)?vk\.(?:com|ru)$/i;
const SHORT_NAME = /^[a-zA-Z0-9_.]+$/;

function fromPath(segment) {
  // Ссылка на пост содержит ID сообщества: wall-123_45 → club123.
  const wall = segment.match(/^wall-(\d+)(?:_\d+)?$/);
  if (wall) return `club${wall[1]}`;
  return SHORT_NAME.test(segment) ? segment : null;
}

/** Возвращает короткое имя сообщества для параметра domain или null, если строка не подходит. */
export function parseGroupLink(line) {
  const value = line.trim().replace(/^@/, '');
  if (!value) return null;
  if (SHORT_NAME.test(value) && !VK_HOSTS.test(value)) return value;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (!VK_HOSTS.test(url.hostname)) return null;
  const [segment] = url.pathname.split('/').filter(Boolean);
  return segment ? fromPath(segment) : null;
}

/** Строки можно разделять переводом строки, запятой или пробелом. */
export function parseGroupLinks(text) {
  const domains = new Map();
  const invalid = [];
  for (const line of text.split(/[\s,]+/).filter(Boolean)) {
    const domain = parseGroupLink(line);
    if (domain) {
      if (!domains.has(domain.toLowerCase())) domains.set(domain.toLowerCase(), domain);
    } else {
      invalid.push(line);
    }
  }
  return { domains: [...domains.values()], invalid };
}
