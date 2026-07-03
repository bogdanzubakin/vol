const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serial REST queue. Uses .then(run, run) so one failed request cannot
 * permanently break subsequent callers (the old restLimiter chain bug).
 */
function createRestQueue(options = {}) {
  const label = options.label ?? "rest";
  let gapValue =
    typeof options.gapMs === "function"
      ? Number(options.gapMs())
      : Number(options.gapMs ?? 0);
  const gapMs = () => gapValue;
  let tail = Promise.resolve();
  let generation = 0;

  function bumpGap(extraMs = 200) {
    gapValue = Math.min(10_000, gapValue + extraMs);
  }

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
      const gap = gapMs();
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

  return { schedule, reset, bumpGap, getGapMs: () => gapValue };
}

module.exports = { createRestQueue, sleep };
