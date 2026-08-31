export type EventHandler<T = unknown> = (payload: T, event: { name: string; at: string }) => void | Promise<void>;

/**
 * In-process publish/subscribe used for workflow triggers.
 *
 * Handlers are isolated: one throwing does not prevent the others from
 * running, and errors surface through `onError` instead of becoming unhandled
 * rejections. Swap this for a Redis-backed bus to span multiple instances.
 */
export class EventBus {
  readonly #handlers = new Map<string, Set<EventHandler<never>>>();

  constructor(private readonly onError?: (error: unknown, eventName: string) => void) {}

  on<T>(eventName: string, handler: EventHandler<T>): () => void {
    const handlers = this.#handlers.get(eventName) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(eventName, handlers);
    return () => this.off(eventName, handler);
  }

  once<T>(eventName: string, handler: EventHandler<T>): () => void {
    const unsubscribe = this.on<T>(eventName, async (payload, event) => {
      unsubscribe();
      await handler(payload, event);
    });
    return unsubscribe;
  }

  off<T>(eventName: string, handler: EventHandler<T>): void {
    this.#handlers.get(eventName)?.delete(handler);
  }

  listeners(eventName: string): number {
    return this.#handlers.get(eventName)?.size ?? 0;
  }

  async emit<T>(eventName: string, payload: T): Promise<void> {
    const handlers = this.#handlers.get(eventName);
    if (!handlers?.size) return;

    const event = { name: eventName, at: new Date().toISOString() };
    await Promise.all(
      [...handlers].map(async (handler) => {
        try {
          await (handler as EventHandler<T>)(payload, event);
        } catch (error) {
          this.onError?.(error, eventName);
        }
      }),
    );
  }
}
