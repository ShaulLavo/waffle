import { CurlError, type CurlRequest, type DataPart } from "./types.ts";

type State = {
  head: boolean;
  include: boolean;
  fail: boolean;
  silent: boolean;
  showError: boolean;
  follow: boolean;
  method?: string;
  output?: string;
  timeoutMs?: number;
  url?: string;
  headers: Headers;
  data: DataPart[];
};

const booleans: Readonly<
  Record<string, keyof Pick<State, "head" | "include" | "fail" | "silent" | "showError" | "follow">>
> = {
  I: "head",
  head: "head",
  i: "include",
  include: "include",
  f: "fail",
  fail: "fail",
  s: "silent",
  silent: "silent",
  S: "showError",
  "show-error": "showError",
  L: "follow",
  location: "follow",
};
const values = new Set([
  "o",
  "output",
  "H",
  "header",
  "X",
  "request",
  "d",
  "data",
  "data-binary",
  "m",
  "max-time",
  "url",
]);

export function parseCurl(argv: readonly string[]): CurlRequest {
  const state: State = {
    head: false,
    include: false,
    fail: false,
    silent: false,
    showError: false,
    follow: false,
    headers: new Headers(),
    data: [],
  };
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (positional || !arg.startsWith("-") || arg === "-") {
      setUrl(state, arg);
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    index += parseOption(state, arg, argv[index + 1]);
  }
  if (!state.url) throw new CurlError(2, "no URL specified");
  const url = parseUrl(state.url);
  const method = state.method ?? (state.head ? "HEAD" : state.data.length ? "POST" : "GET");
  if (state.data.length && (state.head || /^(GET|HEAD)$/i.test(method)))
    throw new CurlError(2, "Fetch does not support a GET or HEAD request body");
  return { ...state, url, method, output: state.output, timeoutMs: state.timeoutMs };
}

function setUrl(state: State, value: string): void {
  if (state.url !== undefined) throw new CurlError(2, "only one URL per invocation is supported");
  state.url = value;
}

function parseOption(state: State, arg: string, next: string | undefined): number {
  if (arg.startsWith("--")) return longOption(state, arg.slice(2), next);
  const flags = arg.slice(1);
  for (let index = 0; index < flags.length; index++) {
    const flag = flags.charAt(index);
    if (setBoolean(state, flag)) continue;
    const attached = flags.slice(index + 1);
    setValue(state, flag, attached || next);
    return attached ? 0 : 1;
  }
  return 0;
}

function longOption(state: State, arg: string, next: string | undefined): number {
  const equal = arg.indexOf("=");
  const name = equal < 0 ? arg : arg.slice(0, equal);
  if (equal < 0 && setBoolean(state, name)) return 0;
  setValue(state, name, equal < 0 ? next : arg.slice(equal + 1));
  return equal < 0 ? 1 : 0;
}

function setBoolean(state: State, name: string): boolean {
  const field = Object.hasOwn(booleans, name) ? booleans[name] : undefined;
  if (!field) return false;
  state[field] = true;
  return true;
}

function setValue(state: State, name: string, value: string | undefined): void {
  if (!values.has(name)) throw new CurlError(2, `unsupported option: ${name}`);
  if (value === undefined) throw new CurlError(2, `option ${name} requires a value`);
  switch (name) {
    case "o":
    case "output":
      state.output = value;
      return;
    case "H":
    case "header":
      addHeader(state.headers, value);
      return;
    case "X":
    case "request":
      state.method = parseMethod(value);
      return;
    case "d":
    case "data":
      state.data.push({ value, binary: false });
      return;
    case "data-binary":
      state.data.push({ value, binary: true });
      return;
    case "m":
    case "max-time":
      state.timeoutMs = parseSeconds(value);
      return;
    case "url":
      setUrl(state, value);
      return;
  }
}

function parseMethod(value: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value))
    throw new CurlError(2, "invalid request method");
  if (/^(CONNECT|TRACE|TRACK)$/i.test(value))
    throw new CurlError(2, "request method is forbidden by Fetch");
  return value;
}

function parseSeconds(value: string): number {
  const seconds = Number(value);
  if (
    !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 2147483
  )
    throw new CurlError(2, "max-time must be positive finite seconds, at most 2147483");
  return Math.max(1, Math.ceil(seconds * 1000));
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CurlError(3, "expected an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new CurlError(1, "only HTTP and HTTPS are supported");
  if (url.username || url.password)
    throw new CurlError(3, "URL credentials are unsupported; use an explicit allowed header");
  return url;
}

function addHeader(headers: Headers, value: string): void {
  const colon = value.indexOf(":");
  if (colon < 1) throw new CurlError(2, "header must have the form Name: value");
  const name = value.slice(0, colon).trim();
  const content = value.slice(colon + 1).trim();
  if (!content) throw new CurlError(2, "header removal and empty headers are unsupported");
  if (
    /^(accept-charset|accept-encoding|access-control-request-.*|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|permissions-policy|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i.test(
      name,
    )
  )
    throw new CurlError(2, `header ${name} is controlled by browser Fetch`);
  try {
    headers.append(name, content);
  } catch {
    throw new CurlError(2, "invalid header");
  }
}
