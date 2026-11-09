import { installFrameworkBootstrap } from "./framework-bootstrap.js";
import { getFrameworkObservation } from "./framework-page.js";
Reflect.set(globalThis, "install", installFrameworkBootstrap);
Reflect.set(globalThis, "accessor", getFrameworkObservation);
