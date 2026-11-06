import { expect, test } from "bun:test";
import { associateListener, nativeCapabilities } from "./safari-driver.js";
import { parseSession } from "./driver.js";
const udid = "10128D70-92A7-4626-9CE5-1537CF27BE84";
const capabilities = {
  browserName: "Safari",
  browserVersion: "26.5",
  platformName: "iOS",
  "safari:useSimulator": true,
  "safari:deviceUDID": udid,
  "safari:platformVersion": "26.5",
  "safari:deviceName": "iPhone",
};
test("native session parser records the exact session before checking its installed runtime tuple", () => {
  const answer = { sessionId: "owned-session", capabilities };
  expect(parseSession(answer)).toBe("owned-session");
  expect(nativeCapabilities(answer, udid)).toEqual({
    browserName: "Safari",
    browserVersion: "26.5",
    platformName: "iOS",
    simulator: true,
    deviceUDID: udid,
    platformVersion: "26.5",
    deviceName: "iPhone",
  });
});
for (const mismatch of [
  { "safari:deviceUDID": "wrong-device" },
  { browserName: "Chrome" },
  { platformName: "macOS" },
  { "safari:useSimulator": false },
  { "safari:useSimulator": undefined },
  { browserVersion: "" },
]) {
  test(`native session rejects mismatched capabilities ${JSON.stringify(mismatch)}`, () => {
    const answer = {
      sessionId: "retained-for-delete",
      capabilities: { ...capabilities, ...mismatch },
    };
    expect(parseSession(answer)).toBe("retained-for-delete");
    expect(() => nativeCapabilities(answer, udid)).toThrow();
  });
}

test("an HTTP response or foreign listener is not a launcher/XPC association", () => {
  const domain = "pid/100/com.apple.WebDriver.HTTPService = {\n\tpid = 321\n}";
  const identity =
    "321 1 501 Fri Nov 6 13:00:00 2026 /System/Library/PrivateFrameworks/WebDriver.framework/Versions/A/XPCServices/com.apple.WebDriver.HTTPService.xpc/Contents/MacOS/com.apple.WebDriver.HTTPService";
  expect(associateListener("p321\nn127.0.0.1:456", domain, identity, 100, 456, 501)?.kind).toBe(
    "launchd-service",
  );
  expect(associateListener("p321\nn127.0.0.1:456", "HTTP 200", identity, 100, 456, 501)).toBeNull();
  expect(associateListener("p321\nn127.0.0.1:456", domain, identity, 100, 456, 999)).toBeNull();
  expect(
    associateListener("p321\nn127.0.0.1:456\nnforeign:456", domain, identity, 100, 456, 501),
  ).toBeNull();
  expect(associateListener("p100\nn127.0.0.1:456", "", "", 100, 456, 501)).toEqual({
    kind: "launcher",
  });
});
