export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Response>();
  private key(request: RequestInfo | URL): string {
    return request instanceof Request ? request.url : String(request);
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(this.key(request))?.clone();
  }
  async matchAll(request?: RequestInfo | URL): Promise<readonly Response[]> {
    if (request) {
      const response = await this.match(request);
      return response ? [response] : [];
    }
    return Array.from(this.entries.values(), (response) => response.clone());
  }
  async keys(): Promise<readonly Request[]> {
    return Array.from(this.entries.keys(), (key) => new Request(key));
  }
  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(request));
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(this.key(request), response.clone());
  }
  async add(): Promise<void> {
    throw new Error("network forbidden");
  }
  async addAll(): Promise<void> {
    throw new Error("network forbidden");
  }
}
export class MemoryCacheStorage implements CacheStorage {
  readonly caches = new Map<string, MemoryCache>();
  async open(name: string): Promise<MemoryCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const response = await cache.match(request);
      if (response) return response;
    }
    return undefined;
  }
}
