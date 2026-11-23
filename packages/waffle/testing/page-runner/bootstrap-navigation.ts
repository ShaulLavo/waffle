import type { Driver } from "./driver.js";

/** Native navigation must join the bootstrap request before admitting observation. */
export async function settleBootstrapNavigation(
  driver: Pick<Driver, "script">,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  if (new URL(url).pathname !== "/_waffle_observation_bootstrap") return;
  const settled = await driver.script(
    `return globalThis.__waffleObservationArrival.then(result => {
      if (result.error !== undefined) throw new Error(result.error);
      if (result.status !== 204) throw new Error('Bootstrap arrival HTTP ' + result.status);
      return true;
    });`,
    signal,
  );
  if (settled !== true) throw new Error("Bootstrap arrival did not settle");
}
