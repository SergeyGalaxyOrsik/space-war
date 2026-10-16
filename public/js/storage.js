// localStorage может быть недоступен (приватный режим, запрет cookies) — не падаем.

const PREFIX = 'pss.';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // квота или запрет — состояние просто не переживёт перезагрузку
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

export function sessionLoad(key) {
  try {
    return sessionStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function sessionSave(key, value) {
  try {
    sessionStorage.setItem(PREFIX + key, value);
  } catch {
    // ignore
  }
}
