import { expect, test } from "bun:test";
import { bootstrapIdentityClasses, bootstrapURLClass } from "./bootstrap-diagnostics.js";
import { SafariDriver } from "./safari-driver.js";
import { SafariObserver } from "./safari-observer.js";
import { HostConsumers } from "./owned-consumers.js";
import type { DriverObservationBinding } from "./driver.js";

const binding: DriverObservationBinding = {
  window: "private-window",
  bootstrapURL: "https://private.test/_waffle_observation_bootstrap?token=private-marker",
  expectedURL: "https://private.test/private-page?token=private-marker",
  signal: new AbortController().signal,
  consumers: new HostConsumers(),
};

test("bootstrap URL and parsed identity diagnostics disclose classes only", () => {
  const inputs = [
    binding.bootstrapURL,
    binding.expectedURL,
    "about:blank",
    "",
    "https://private.test/other",
    "https://foreign.test/private",
    undefined,
  ];
  expect(inputs.map((value) => bootstrapURLClass(value, binding))).toEqual([
    "bootstrap",
    "expected-page",
    "about:blank",
    "empty",
    "same-origin-other",
    "other",
    "unavailable",
  ]);
  expect(
    bootstrapIdentityClasses(
      JSON.stringify({ url: binding.bootstrapURL, marker: "private-marker" }),
      binding,
    ),
  ).toBe("url=bootstrap marker=present");
  expect(
    bootstrapIdentityClasses(JSON.stringify({ url: "about:blank", marker: null }), binding),
  ).toBe("url=about:blank marker=absent");
  expect(
    bootstrapIdentityClasses(
      JSON.stringify({ url: binding.expectedURL, marker: "different-private-marker" }),
      binding,
    ),
  ).toBe("url=expected-page marker=different");
  for (const input of ["malformed private-marker", "null", "42", undefined])
    expect(bootstrapIdentityClasses(input, binding)).toBe("url=unavailable marker=absent");
});

for (const mismatch of ["handle", "url", "identity"] as const) {
  test(`actual Safari observation ${mismatch} refusal keeps short-circuit command order`, async () => {
    const calls: string[] = [];
    const driver = new SafariDriver("cpu-device", "unused", undefined, "unused-receipt");
    Reflect.set(driver, "descriptor", { capabilities: { "safari:deviceUDID": "cpu-device" } });
    driver.handle = async () => {
      calls.push("handle");
      return mismatch === "handle" ? "foreign-private-window" : binding.window;
    };
    driver.url = async () => {
      calls.push("url");
      return mismatch === "url" ? "about:blank" : binding.bootstrapURL;
    };
    driver.script = async () => {
      calls.push("identity");
      return JSON.stringify({ url: binding.bootstrapURL, marker: "foreign-private-marker" });
    };
    const expected =
      mismatch === "handle"
        ? "SafariDriver bootstrap ownership changed: check=handle url=not-read"
        : mismatch === "url"
          ? "SafariDriver bootstrap ownership changed: check=url url=about:blank"
          : "SafariDriver bootstrap document changed: url=bootstrap marker=different";
    await expect(driver.observe(binding)).rejects.toThrow(expected);
    expect(calls).toEqual(
      mismatch === "handle"
        ? ["handle"]
        : mismatch === "url"
          ? ["handle", "url"]
          : ["handle", "url", "identity"],
    );
  });
}

for (const count of [0, 2]) {
  test(`actual Inspector selection reports ${count} matches and per-application counts without private rows`, async () => {
    const observer = new SafariObserver(binding);
    let sequence = 0;
    const feed = (selector: string, argument: import("./inspector-plist.js").PlistDict) =>
      observer.accept({ selector, argument, sequence: ++sequence });
    observer.connectTransport({
      async send(selector, args) {
        if (selector === "_rpc_reportIdentifier:")
          feed("_rpc_reportConnectedApplicationList:", {
            WIRApplicationDictionaryKey: { "private-app-a": {}, "private-app-b": {} },
          });
        if (selector !== "_rpc_forwardGetListing:") return;
        feed("_rpc_applicationSentListing:", {
          WIRApplicationIdentifierKey: args.WIRApplicationIdentifierKey ?? "",
          WIRListingKey: {
            "private-row": {
              WIRPageIdentifierKey: 17,
              WIRTypeKey: "WIRTypeWebPage",
              WIRTitleKey: "private-title",
              WIRURLKey: count ? binding.bootstrapURL : "https://foreign.test/private",
            },
          },
        });
      },
      async close() {},
    });
    try {
      await expect(observer.attach()).rejects.toThrow(
        `Exact owned bootstrap not uniquely listed: ${JSON.stringify({
          matches: count,
          applications: 2,
          listings: 2,
          rows: 2,
          pageRows: 2,
          perApplication: [
            { application: 1, rows: 1, pageRows: 1, matches: count / 2 },
            { application: 2, rows: 1, pageRows: 1, matches: count / 2 },
          ],
        })}`,
      );
    } finally {
      await observer.close();
    }
  });
}
