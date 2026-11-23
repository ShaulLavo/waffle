import { installFrameworkBootstrap } from "../../testing/page-runner/framework-bootstrap.js";
import { getFrameworkObservation } from "../../testing/page-runner/framework-page.js";
Reflect.set(globalThis, "install", installFrameworkBootstrap);
Reflect.set(globalThis, "accessor", getFrameworkObservation);
