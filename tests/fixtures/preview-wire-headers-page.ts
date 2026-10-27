import { PreviewRouter } from "../../browser/preview.js";
import type { PreviewHostExchange, PreviewHostOutput } from "../../browser/preview-host.js";

/** @browserEntry */
export async function wireHeaderBrowserCase() {
  const router = new PreviewRouter({ mode: "root", originForPort: () => location.origin });
  let received = "";
  const encoder = new TextEncoder();
  const reply =
    "HTTP/1.1 201 Created\r\nSet-Cookie: wire_first=1; Path=/; SameSite=Strict\r\nSet-Cookie: wire_second=2; Path=/; SameSite=Strict\r\nX-Repeat: a\r\nX-Repeat: b\r\nContent-Length: 2\r\n\r\nok";
  router.register(3137, {
    request() {
      throw new Error("Expected shared raw transport");
    },
    connect(_port, sink) {
      return {
        write(bytes) {
          received = new TextDecoder().decode(bytes);
          void sink.data(encoder.encode(reply));
        },
        close() {
          sink.end();
        },
      };
    },
  });
  const relay = await router.bindHost({ port: 3137 });
  try {
    document.cookie = "wire_input=1; Path=/; SameSite=Strict";
    const raw: { headers: [string, string][] } = await (
      await fetch("/native-headers", { method: "POST" })
    ).json();
    const messages: PreviewHostOutput[] = [];
    const exchange: PreviewHostExchange = {
      onmessage: null,
      close() {},
      postMessage(message) {
        messages.push(message);
        if (message.type === "data") exchange.onmessage?.({ type: "pull" });
      },
    };
    await relay.dispatch(
      {
        type: "http",
        authorization: relay.authorization,
        url: location.origin + "/virtual-app",
        method: "POST",
        headers: raw.headers,
        body: null,
      },
      exchange,
    );
    const originArrived = /^origin: /im.test(received);
    const cookieArrived = /^cookie: /im.test(received);
    const head = messages.find((message) => message.type === "head");
    if (!head) throw new Error("Wire response head missing");
    const responseCookies = head.headers.filter(
      ([name]) => name.toLowerCase() === "set-cookie",
    ).length;
    await fetch("/native-response", { method: "POST", body: JSON.stringify(head) });
    const nativeCookies =
      document.cookie.includes("wire_first=") && document.cookie.includes("wire_second=");
    const guarded = new Request(location.origin + "/dom-api", {
      method: "POST",
      headers: raw.headers,
    });
    const domResponse = await relay.fetch(relay.authorization, guarded);
    await domResponse.text();
    return {
      nativeOriginPresent: raw.headers.some(([name]) => name === "origin"),
      nativeCookiePresent: raw.headers.some(([name]) => name === "cookie"),
      originArrived,
      cookieArrived,
      responseCookies,
      nativeCookies,
      domOriginPresent: /^origin: /im.test(received),
      domCookiePresent: /^cookie: /im.test(received),
      domResponseCookiePresent: domResponse.headers.has("set-cookie"),
      repeatedResponseFields: head.headers.filter(([name]) => name === "x-repeat").length,
    };
  } finally {
    relay.close();
  }
}
