const queues = new WeakMap();
export async function serial(db, key, fn) {
  let map = queues.get(db);
  if (!map) {
    map = new Map();
    queues.set(db, map);
  }
  const previous = map.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  map.set(key, current);
  try {
    return await current;
  } finally {
    if (map.get(key) === current) map.delete(key);
  }
}
