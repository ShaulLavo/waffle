import { startPage, cleanupStorage } from "waffle/testing/page-runner/page";
startPage<null>({
  list: async () => ["fixture"],
  async run(_request, _allocate, context) {
    if (context.serviceWorker !== null) throw new Error("Undeclared worker capability");
    const config = await context.fetchFixture("/config");
    const value = await config.json();
    if (value.origin !== location.origin)
      throw new Error("Fixture started with wrong bound origin");
    let refused = false;
    try {
      await context.fetchFixture("/undeclared");
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("Undeclared callback path accepted");
    const idle = await context.fetchFixture("/idle");
    if (!idle.ok) throw new Error(`Idle callback rejected ${idle.status}`);
    const counts = await idle.json();
    if (counts.sockets !== 0) throw new Error("Actual idle socket count is not zero");
    return counts;
  },
  finish: cleanupStorage,
});
