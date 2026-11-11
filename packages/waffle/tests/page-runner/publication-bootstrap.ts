import { installWorkspaceChannelObserver } from "../fixtures/publication-channel-observer.js";
import { record } from "./protocol.js";

export function installPublicationBootstrap(): void {
  installWorkspaceChannelObserver();
  const configuration = window.__suiteConfiguration;
  const documentURL = location.href;
  Reflect.set(globalThis, "__publicationWaitForClose", async (url: string) => {
    if (typeof url !== "string" || !url || url.length > 16_384)
      throw new Error("Invalid Worker close URL");
    const response = await fetch("/_waffle_worker_close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run: configuration.run,
        token: configuration.token,
        doc: window.__pageRunner.doc,
        documentURL,
        url,
      }),
    });
    const answer: unknown = await response.json();
    if (!response.ok || !record(answer) || answer.closed !== true)
      throw new Error(`Browser Worker close query failed: ${JSON.stringify(answer)}`);
  });
}
