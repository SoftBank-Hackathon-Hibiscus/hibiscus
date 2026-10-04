export class GatewayAdmission {
  private readonly apps = new Map<
    string,
    { active: number; queue: Array<() => void> }
  >();
  acquire(
    id: string,
    limit: number,
    maxQueue: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<(() => void) | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const state = this.apps.get(id) ?? { active: 0, queue: [] };
    this.apps.set(id, state);
    const slot = () => {
      state.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.active--;
        state.queue.shift()?.();
        if (!state.active && !state.queue.length) this.apps.delete(id);
      };
    };
    if (state.active < limit) return Promise.resolve(slot());
    if (state.queue.length >= maxQueue) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      };
      const enter = () => {
        cleanup();
        resolve(slot());
      };
      const cancel = () => {
        const index = state.queue.indexOf(enter);
        if (index >= 0) state.queue.splice(index, 1);
        cleanup();
        resolve(undefined);
      };
      const timer = setTimeout(cancel, waitMs);
      timer.unref();
      signal.addEventListener('abort', cancel, { once: true });
      state.queue.push(enter);
    });
  }
  snapshot() {
    return [...this.apps].map(([applicationId, state]) => ({
      applicationId,
      active: state.active,
      queued: state.queue.length,
    }));
  }
}
