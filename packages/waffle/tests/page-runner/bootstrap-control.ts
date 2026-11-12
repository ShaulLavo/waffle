import { expect } from "bun:test";

export async function loadBootstrap(url: string): Promise<void> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  const html = await response.text();
  const script = /<script>(.*?)<\/script>/.exec(html);
  if (!script?.[1]) throw new Error("Missing bootstrap arrival script");
  const marker = html.indexOf('data-waffle-observation="');
  expect(marker).toBeGreaterThan(0);
  expect(html.indexOf("<script>")).toBeGreaterThan(marker);
  let requests = 0;
  const arrived: Response = await new Function("fetch", `return ${script[1]}`)((path: string) => {
    requests++;
    return fetch(new URL(path, url));
  });
  expect(requests).toBe(1);
  expect(arrived.status).toBe(204);
}
