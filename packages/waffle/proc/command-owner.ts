import type { BrowserProcessBroker } from "../browser/process-broker.js";
import type { ProcessService, Runtime } from "../runtime.js";

export const commandOwners = new WeakMap<ProcessService, BrowserProcessBroker>();
export const commandDisposals = new WeakMap<Runtime, AbortController>();
