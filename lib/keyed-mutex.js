/**
 * Per-key exclusive runner. If the same key is re-entered while busy, the new
 * run is deferred and coalesced (only one follow-up runs after the current one).
 */
function createKeyedExclusive() {
  const busy = new Set();
  const dirty = new Set();

  function runExclusive(key, fn) {
    if (busy.has(key)) {
      dirty.add(key);
      return;
    }
    busy.add(key);
    try {
      do {
        dirty.delete(key);
        fn();
      } while (dirty.has(key));
    } finally {
      busy.delete(key);
    }
  }

  return { runExclusive };
}

/** Serialize async work per key (queued, not dropped). */
function createKeyedAsyncQueue() {
  const tails = new Map();

  function enqueue(key, fn) {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => fn());
    tails.set(key, next);
    return next.finally(() => {
      if (tails.get(key) === next) tails.delete(key);
    });
  }

  return { enqueue };
}

module.exports = { createKeyedExclusive, createKeyedAsyncQueue };
