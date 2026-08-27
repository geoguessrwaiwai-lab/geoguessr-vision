/**
 * `items`に対して`fn`を、同時実行数`limit`を超えないように実行する。
 * 単純な逐次処理(1地点が完全に終わってから次を始める)は、ほとんどの時間をネットワークI/O待ちのアイドル時間として無駄にしてしまう。
 * 小さな同時実行プールを使うことで、Google側の(非公式・無認証の)タイルエンドポイントに何千もの同時リクエストを浴びせることなく、
 * その待ち時間を地点間でオーバーラップさせられる。
 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
