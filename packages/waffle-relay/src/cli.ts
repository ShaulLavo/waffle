#!/usr/bin/env node
import { createNodeRelayServer } from "./node.js";
import { serveConfig } from "./cli-config.js";
import { mintRelayToken } from "./token.js";

async function main(): Promise<void> {
  const config = await serveConfig(process.argv.slice(2));
  const relay = createNodeRelayServer(config.options);
  const stop = () => {
    void relay.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      relay.server.once("error", reject);
      relay.server.listen(config.listen.port, config.listen.host, () => {
        relay.server.removeListener("error", reject);
        resolve();
      });
    });
    if (config.dev) {
      const tcp = config.options.tcp!;
      const token = await mintRelayToken(tcp.tokenSecret, {
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: "local-development",
        dst: tcp.destinations ?? [],
      });
      process.stderr.write(
        `Development token, expires in 3600 seconds. Do not copy into logs or guest state.\n${token}\n`,
      );
    }
  } catch (error) {
    await relay.close();
    throw error;
  }
}
void main().catch(() => {
  process.stderr.write(
    "Relay startup failed. Check flags, protected secret files, policy and listener availability.\n",
  );
  process.exitCode = 1;
});
