import assert from "node:assert/strict";
import {cpSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {playwright, session, ready, run, writeFile} from "./playground.mjs";
import {firstVisit} from "./first-visit.mjs";
const s = session("bun-wasm-crypto-browser-");
try {
  const root = join(s.scratch, "dist");
  cpSync(new URL("../dist/", import.meta.url), root, {recursive:true});
  const preload = readFileSync(new URL("./crypto-provider-preload.mjs", import.meta.url), "utf8")
    .replace("await provider.generateKey", "provider.generateKey");
  for (const path of ["worker.js", "__bunwasm/worker.js"]) {
    const file = join(root, path);
    writeFileSync(file, preload + "\n" + readFileSync(file, "utf8"));
  }
  const [, url] = await s.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, {ROOT:root, PORT:"0"});
  const source = readFileSync(new URL("../../tests/fixtures/crypto-native-provider/index.js", import.meta.url), "utf8");
  for (const name of ["chromium", "webkit"]) {
    const browser = await s.launch(playwright[name]);
    const context = await browser.newContext();
    const visit = await firstVisit(context, `${url}?engine=browser`);
    try {
      const page = await context.newPage();
      await page.goto(visit.url);
      assert.match(await ready(page), /ready/);
      await writeFile(page, "/home/user/crypto-native.js", source);
      const result = await run(page, "bun run crypto-native.js");
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /native provider and CryptoKeys preserved/);
      console.log(`PASS ${name} original SubtleCrypto and native CryptoKeys`);
      for (const fixture of ["crypto-vectors", "crypto-native-aes192", "crypto-hmac-required-hash", "crypto-sha1-jwk", "crypto-p384-sha1"]) {
        const folder = new URL(`../../tests/fixtures/${fixture}/`, import.meta.url);
        for (const file of readdirSync(folder).filter(file => /\.(js|json)$/.test(file)))
          await writeFile(page, `/home/user/${fixture}/${file}`, readFileSync(new URL(file, folder), "utf8"));
        const result = await run(page, `bun run ${fixture}/index.js`);
        assert.equal(result.code, 0, result.output);
        const expected = readFileSync(new URL("expected.txt", folder), "utf8").trim().split("\n");
        for (const line of expected) assert(result.output.includes(line), result.output);
        console.log(`PASS ${name} ${fixture}`);
      }
    } finally {
      await visit.close();
      await browser.close();
    }
  }
} finally {
  await s.cleanup();
}
