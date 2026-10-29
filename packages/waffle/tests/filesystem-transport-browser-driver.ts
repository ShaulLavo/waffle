import { firefox, chromium } from "playwright";

const [engine = "firefox", port = "4301", rounds = "60", concurrency = "2"] = process.argv.slice(2);
if (engine !== "firefox" && engine !== "chromium") throw Error(`unsupported engine ${engine}`);
const browser = await (engine === "firefox" ? firefox : chromium).launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(args => window.run(args.rounds, args.concurrency, true), {
    rounds: Number(rounds), concurrency: Number(concurrency),
  });
  console.log(JSON.stringify({ engine, version: browser.version(), rounds: Number(rounds), concurrency: Number(concurrency), result }));
} finally { await browser.close(); }
