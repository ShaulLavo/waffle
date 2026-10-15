// The installer uses safelisted Accept headers, so npm needs no CORS preflight.
const METADATA = "application/vnd.npm.install-v1+json";
const TARBALL = "application/vnd.bun.install-tarball";
const CACHE = "bun-wasm-install-v1";
const TIME = "x-bun-wasm-cached-at";

/** Cache npm downloads across playground runs, without caching ordinary user fetches. */
export async function installFetch(url: string, options: RequestInit): Promise<Response> {
  const header = new Headers(options.headers).get("accept") ?? "";
  const accept = header.split(";", 1)[0];
  const refresh = header.includes("; no-cache");
  if (options.method !== "GET" || accept !== METADATA && accept !== TARBALL || typeof caches === "undefined") {
    return fetch(url, options);
  }
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE);
    const cached = await cache.match(url);
    const fresh = accept === TARBALL || Date.now() - Number(cached?.headers.get(TIME) ?? 0) < 300000;
    if (cached && fresh && !refresh) return cached;
  } catch {
    // Private browsing and exhausted quotas must not prevent an install.
  }
  const response = await fetch(url, options);
  if (response.ok && cache) await store(cache, url, response.clone());
  return response;
}

async function store(cache: Cache, url: string, response: Response): Promise<void> {
  try {
    const headers = new Headers(response.headers);
    headers.set(TIME, String(Date.now()));
    await cache.put(url, new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
  } catch {
    // The guest still receives the original response when persistence is unavailable.
  }
}
