// WebSocket-соединение с автоматическим переподключением.
// Состояния: idle (в лобби) → connecting → online → offline (ждём и пробуем снова);
// kicked и denied — конечные, сами не переподключаемся.

const WATCHDOG_MS = 4000;
const FINAL = new Set(['idle', 'kicked', 'denied']);

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

    window.addEventListener('online', () => {
      if (this.state === 'offline') this.reconnectNow();
    });
    window.addEventListener('offline', () => this.drop());
    setInterval(() => this.watchdog(), 1000);
  }

  get online() {
    return this.state === 'online';
  }

  open() {
    this.attempt = 0;
    this.close();
    this.connect();
  }

  // Выход в лобби: закрываем соединение и больше не переподключаемся.
  close() {
    clearTimeout(this.retryTimer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.close(1000, 'leave');
    }
    this.setState('idle');
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (this.ws) return;
    const ws = new WebSocket(serverUrl());
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
      if (msg.t === 'denied') this.setState('denied');
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    };
    ws.onclose = () => {
      if (this.ws === ws) this.handleClosed();
    };
    ws.onerror = () => {};
  }

  // Соединение «зависло»: сообщения не приходят, хотя сокет формально открыт.
  watchdog() {
    if (this.ws && this.state === 'online' && performance.now() - this.lastMessageAt > WATCHDOG_MS) this.drop();
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
    if (FINAL.has(this.state)) return;
    const delay = Math.min(8000, 500 * 2 ** this.attempt) + Math.random() * 300;
    this.attempt++;
    this.retryAt = performance.now() + delay;
    this.setState('offline');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  reconnectNow() {
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
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: state }));
  }
}

function serverUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
