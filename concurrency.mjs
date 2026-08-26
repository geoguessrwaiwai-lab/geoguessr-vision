// Runs `fn` over `items` with at most `limit` in flight at once. Plain sequential
// processing (one location fully done before the next starts) leaves most of the wall-clock
// time idle waiting on network I/O; a small concurrency pool overlaps that waiting across
// locations without blasting Google's (unofficial, unauthenticated) tile endpoint with
// thousands of simultaneous requests.
export async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
