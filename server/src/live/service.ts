import { getAdapter as defaultGetAdapter } from "../sites/index.js";
import type { EpisodeContent, NovelInfo, SiteAdapter, SiteId } from "../sites/types.js";

/** 単純な TTL 付き LRU(Map の挿入順を利用)。 */
export class TtlLru<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(
    private max = 200,
    private ttlMs = 5 * 60 * 1000,
    private now: () => number = Date.now,
  ) {}
  get(key: string): V | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp <= this.now()) {
      this.m.delete(key);
      return undefined;
    }
    this.m.delete(key);
    this.m.set(key, e);
    return e.v;
  }
  set(key: string, v: V): void {
    this.m.delete(key);
    this.m.set(key, { v, exp: this.now() + this.ttlMs });
    while (this.m.size > this.max) {
      const first = this.m.keys().next().value as string;
      this.m.delete(first);
    }
  }
  get size(): number {
    return this.m.size;
  }
}

export interface LiveService {
  getAdapter(site: SiteId): SiteAdapter;
  getNovel(site: SiteId, novelKey: string): Promise<NovelInfo>;
  getEpisode(site: SiteId, novelKey: string, episodeKey: string): Promise<EpisodeContent>;
}

/** ライブ取得(interactive 優先度)+ メモリキャッシュ(TTL 5 分 / 200 件)。ルート間で共有する。 */
export function createLiveService(getAdapter: (site: SiteId) => SiteAdapter = defaultGetAdapter): LiveService {
  const cache = new TtlLru<NovelInfo | EpisodeContent>(200, 5 * 60 * 1000);
  const inflight = new Map<string, Promise<unknown>>();

  async function cached<T extends NovelInfo | EpisodeContent>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit) return hit as T;
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load()
        .then((v) => {
          cache.set(key, v);
          return v;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  return {
    getAdapter,
    getNovel: (site, novelKey) =>
      cached(`${site}:n:${novelKey}`, () => getAdapter(site).fetchNovel(novelKey, { priority: "interactive" })),
    getEpisode: (site, novelKey, episodeKey) =>
      cached(`${site}:e:${novelKey}:${episodeKey}`, () =>
        getAdapter(site).fetchEpisode(novelKey, episodeKey, { priority: "interactive" }),
      ),
  };
}
