import { buildEcho } from "./build-echo.ts";

if (!process.env.COREUTILS_ARTIFACTS) buildEcho();
await import("./build.ts");
