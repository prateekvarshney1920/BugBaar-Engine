/** Something that can be closed during shutdown — in practice, an SSE response. */
export interface Closable {
  end(): void;
  writableEnded: boolean;
}

/**
 * Tracks open server-sent-event responses so shutdown can end them.
 *
 * `server.close()` stops accepting connections and then waits for the open
 * ones to finish. An SSE stream never finishes on its own, so a deploy with
 * one active stream hung until the shutdown watchdog fired `process.exit(1)` —
 * making every such deploy look like a crash to an orchestrator, and killing
 * in-flight work mid-write.
 *
 * Ending the streams first turns that into an ordinary, prompt shutdown.
 */
export class StreamRegistry {
  readonly #open = new Set<Closable>();
  #onChange?: (size: number) => void;

  /** Reports the open-stream count whenever it changes, for the gauge. */
  onChange(listener: (size: number) => void): void {
    this.#onChange = listener;
    listener(this.#open.size);
  }

  get size(): number {
    return this.#open.size;
  }

  /** Registers a stream and returns the function that unregisters it. */
  add(stream: Closable): () => void {
    this.#open.add(stream);
    this.#onChange?.(this.#open.size);

    return () => {
      this.#open.delete(stream);
      this.#onChange?.(this.#open.size);
    };
  }

  /** Ends every open stream. Safe to call when there are none. */
  closeAll(): number {
    const closed = this.#open.size;

    for (const stream of this.#open) {
      if (!stream.writableEnded) stream.end();
    }
    this.#open.clear();
    this.#onChange?.(0);

    return closed;
  }
}
