// Network events wake background tabs without depending on throttled poll timers.
export class AgentConnection {
  constructor(onWake, { fetcher = fetch, retryMs = 3000 } = {}) {
    this.onWake = onWake; this.fetcher = fetcher; this.retryMs = retryMs;
    this.controller = null; this.timer = null; this.stopped = true;
  }
  start() { if (!this.stopped) return; this.stopped = false; this.connect(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.controller?.abort(); }
  async connect() {
    const controller = this.controller = new AbortController();
    try {
      const session = await this.fetcher('/api/session', { signal: controller.signal });
      if (!session.ok) throw Error('Cannot read Studio session');
      const { token } = await session.json();
      const response = await this.fetcher('/api/agent/stream', { signal: controller.signal, headers: { 'X-Studio-Token': token } });
      if (!response.ok || !response.body) throw Error('Studio connection unavailable');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      try {
        while (!this.stopped) {
          const { done, value } = await reader.read(); if (done) break;
          pending += decoder.decode(value, { stream: true });
          let end;
          while ((end = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            if (frame.startsWith('data:')) this.onWake();
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch { /* Poll fallback remains available during a reconnect. */ }
    finally {
      if (this.controller === controller && !this.stopped) this.timer = setTimeout(() => this.connect(), this.retryMs);
    }
  }
}
