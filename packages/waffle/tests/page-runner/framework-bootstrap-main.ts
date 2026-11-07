import { installFrameworkBootstrap } from "./framework-bootstrap.js";
const config: unknown = Reflect.get(window, "__waffleFrameworkConfiguration");
if (
  typeof config !== "object" ||
  config === null ||
  !("run" in config) ||
  !("token" in config) ||
  !("kind" in config) ||
  !("url" in config) ||
  typeof config.run !== "string" ||
  typeof config.token !== "string" ||
  typeof config.url !== "string" ||
  (config.kind !== "orchestrator" && config.kind !== "tester")
)
  throw new Error("Missing framework bootstrap configuration");
installFrameworkBootstrap({
  run: config.run,
  token: config.token,
  kind: config.kind,
  url: config.url,
});
