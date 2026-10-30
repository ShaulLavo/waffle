import { buildEcho } from "./build-echo.ts";
import { buildDate } from "./build-date.ts";

if (!process.env.COREUTILS_ARTIFACTS) {
  buildEcho();
  buildDate();
}
await import("./build.ts");
