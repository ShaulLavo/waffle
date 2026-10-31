import { buildChecksums } from "./build-checksums.ts";
import { buildEcho } from "./build-echo.ts";
import { buildDate } from "./build-date.ts";

if (!process.env.COREUTILS_ARTIFACTS) {
  buildEcho();
  buildDate();
  buildChecksums();
}
await import("./build.ts");
