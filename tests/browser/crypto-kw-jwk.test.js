import {test,expect} from "bun:test";
import {spawnSync} from "node:child_process";
test("native AES-KW JWK padding gap uses native raw wrapping",()=>{
 const result=spawnSync("node",[new URL("./crypto-kw-jwk-probe.mjs",import.meta.url).pathname],{encoding:"utf8",timeout:10000});
 expect(result.status).toBe(0);expect(result.stderr).toBe("");
 expect(result.stdout).toContain("native AES-KW wraps aligned JWK bytes");
});
