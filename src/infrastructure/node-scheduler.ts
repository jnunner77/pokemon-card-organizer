import type { Scheduler } from '#application/catalog/ports.ts';

/** Node's timers, which never keep the server running by themselves. */
export class NodeScheduler implements Scheduler {
  pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  after(ms: number, job: () => void): () => void {
    const timer = setTimeout(job, ms);
    timer.unref();
    return () => clearTimeout(timer);
  }
}
