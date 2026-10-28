import { resolve } from "node:path";
import { generateRustNotices } from "../../../tools/program-notices.ts";
const root = resolve(import.meta.dirname, "..");
generateRustNotices({ root, packages: ["waffle-grep"], features: "cooperative-wasi" });
