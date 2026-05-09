/**
 * Global concurrency guard for Bee upload requests.
 *
 * Bee's local node enforces a per-connection rate limit on upload endpoints
 * (SOC, /bytes). When multiple concurrent uploads arrive simultaneously —
 * e.g. sites/publish writing 3 feed topics at once while a prepare-order
 * call is also uploading — Bee responds with HTTP 429 "Too many upload requests".
 *
 * The semaphore is held only for the duration of the individual HTTP call, NOT
 * across retry back-off sleeps. A throttled slot releases immediately on 429 so
 * callers aren't blocked by each other's back-off wait.
 */

const MAX_CONCURRENT = 2;

class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.queue.shift()?.();
    };
  }
}

export const beeUploadSem = new Semaphore(MAX_CONCURRENT);
