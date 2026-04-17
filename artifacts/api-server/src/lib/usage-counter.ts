// Tiny in-process rolling 24h counter. We keep one timestamp per event in a
// ring buffer (capped) so the math is `events.filter(t => now - t < 24h).length`.
// When the buffer fills, we drop the oldest 25% in one pass — cheap, accurate
// enough for the dashboard, and resets cleanly on process restart (intentional:
// only operationally-active counts matter for the central usage chart).

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 50_000;

class RollingCounter {
  private events: number[] = [];

  record(): void {
    this.events.push(Date.now());
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, Math.floor(MAX_EVENTS / 4));
    }
  }

  count24h(): number {
    const cutoff = Date.now() - DAY_MS;
    // events are appended in order, so the first index ≥ cutoff is monotonic;
    // drop everything older to bound memory.
    let drop = 0;
    while (drop < this.events.length && this.events[drop]! < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);
    return this.events.length;
  }
}

const aiCounter = new RollingCounter();
const printCounter = new RollingCounter();

export function recordAiQuery(): void {
  aiCounter.record();
}
export function recordPrintJob(): void {
  printCounter.record();
}
export function snapshotUsage(): { ai_questions_24h: number; print_jobs_24h: number } {
  return {
    ai_questions_24h: aiCounter.count24h(),
    print_jobs_24h: printCounter.count24h(),
  };
}
