// WebSocket-соединение с автоматическим переподключением.
// Состояния: connecting → online → offline (ждём и пробуем снова) | kicked.

const WATCHDOG_MS = 4000;

export class Net extends EventTarget {
  constructor({ getHello }) {
    super();
    this.getHello = getHello;
    this.ws = null;
    this.state = 'idle';
    this.attempt = 0;
    this.retryAt = 0;
    this.retryTimer = null;
    this.lastMessageAt = 0;

    window.addEventListener('online', () => this.reconnectNow());
    window.addEventListener('offline', () => this.drop());
    setInterval(() => this.watchdog(), 1000);
  }

  get online() {
    return this.state === 'online';
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (this.ws) return;
    const url = serverUrl();
    const ws = new WebSocket(url);
    this.ws = ws;
    this.setState('connecting');

    ws.onopen = () => {
      this.lastMessageAt = performance.now();
      ws.send(JSON.stringify(this.getHello()));
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = performance.now();
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.attempt = 0;
        this.setState('online');
      }
      if (msg.t === 'kicked') this.setState('kicked');
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.handleClosed();
    };
    ws.onerror = () => {};
  }

  // Соединение «зависло»: сообщения не приходят, хотя сокет формально открыт.
  watchdog() {
    if (this.ws && this.state !== 'kicked' && performance.now() - this.lastMessageAt > WATCHDOG_MS && this.ws.readyState === WebSocket.OPEN) {
      this.drop();
    }
  }

  drop() {
    if (!this.ws) return;
    const ws = this.ws;
    ws.onclose = null;
    ws.close();
    this.handleClosed();
  }

  handleClosed() {
    this.ws = null;
    if (this.state === 'kicked') return;
    const delay = Math.min(8000, 500 * 2 ** this.attempt) + Math.random() * 300;
    this.attempt++;
    this.retryAt = performance.now() + delay;
    this.setState('offline');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
    if (this.state === 'kicked') this.state = 'offline';
    if (this.ws) return;
    this.attempt = 0;
    this.connect();
  }

  send(msg) {
    if (this.state !== 'online' || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  setState(state) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: state }));
  }
}

// Если фронтенд на отдельном хостинге (Vercel), адрес сервера берётся из config.js.
function serverUrl() {
  const base = window.PSS_SERVER;
  if (base) return `${base.replace(/^http/, 'ws')}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
