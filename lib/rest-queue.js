const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serial REST queue. Uses .then(run, run) so one failed request cannot
 * permanently break subsequent callers (the old restLimiter chain bug).
 */
function createRestQueue(options = {}) {
  const label = options.label ?? "rest";
  const gapMs = options.gapMs ?? (() => 0);
  let tail = Promise.resolve();

  function schedule(fn) {
    const run = async () => {
      const gap = typeof gapMs === "function" ? Number(gapMs()) : Number(gapMs);
      if (gap > 0) await sleep(gap);
      return fn();
    };
    const job = tail.then(run, run);
    tail = job.catch((err) => {
      console.error(`${label} REST queue: ${err.message}`);
    });
    return job;
  }

  return { schedule };
}

module.exports = { createRestQueue, sleep };
