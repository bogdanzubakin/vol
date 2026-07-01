const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serial REST queue. Uses .then(run, run) so one failed request cannot
 * permanently break subsequent callers (the old restLimiter chain bug).
 */
function createRestQueue(options = {}) {
  const label = options.label ?? "rest";
  const gapMs = options.gapMs ?? (() => 0);
  let tail = Promise.resolve();
  let generation = 0;

  /** Drop queued work so a new backtest is not blocked by a hung prior request. */
  function reset() {
    generation++;
    tail = Promise.resolve();
  }

  function schedule(fn) {
    const gen = generation;
    const run = async () => {
      if (gen !== generation) {
        const err = new Error("REST queue reset");
        err.code = "QUEUE_RESET";
        throw err;
      }
      const gap = typeof gapMs === "function" ? Number(gapMs()) : Number(gapMs);
      if (gap > 0) await sleep(gap);
      if (gen !== generation) {
        const err = new Error("REST queue reset");
        err.code = "QUEUE_RESET";
        throw err;
      }
      return fn();
    };
    const job = tail.then(run, run);
    tail = job.catch((err) => {
      if (err?.code === "QUEUE_RESET") return;
      console.error(`${label} REST queue: ${err.message}`);
    });
    return job;
  }

  return { schedule, reset };
}

module.exports = { createRestQueue, sleep };
