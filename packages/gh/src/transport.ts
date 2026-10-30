import { HttpError } from "./errors.ts";
import { decode, object, parseJson } from "./json.ts";
import type {
  ApiRequest,
  HttpRequest,
  HttpResponse,
  JsonValue,
  QueryEntry,
  Transport,
} from "./types.ts";

const API_ORIGIN = "https://api.github.com";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class GitHubClient {
  private readonly transport: Transport;
  private readonly token: string;
  constructor(transport: Transport, token: string) {
    this.transport = transport;
    this.token = token;
  }

  async send(request: ApiRequest): Promise<HttpResponse> {
    const url = apiUrl(request.path, request.query);
    const headers = mergeHeaders(request.headers, this.token, request.body !== undefined);
    const body = request.body instanceof Uint8Array ? request.body : encodeBody(request.body);
    const response = await this.transport({ method: request.method, url, headers, body });
    if (response.status >= 200 && response.status < 300) return response;
    throw new HttpError(httpErrorMessage(response), response);
  }

  async json(request: ApiRequest): Promise<JsonValue> {
    return parseJson((await this.send(request)).body);
  }
}

export function apiUrl(path: string, query: readonly QueryEntry[] = []): string {
  const url = new URL(path.startsWith("http") ? path : `${API_ORIGIN}/${path.replace(/^\//, "")}`);
  if (url.origin !== API_ORIGIN || url.protocol !== "https:" || url.username || url.password)
    throw new Error("gh: only https://api.github.com requests are supported");
  for (const [name, value] of query) url.searchParams.append(name, value);
  return url.toString();
}

export function setQuery(path: string, name: string, value: string): string {
  const url = new URL(apiUrl(path));
  url.searchParams.set(name, value);
  return url.toString();
}

export function nextLink(response: HttpResponse): string | undefined {
  const link = responseHeader(response, "link");
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match) return apiUrl(match[1]);
  }
  return undefined;
}

export function responseHeader(response: HttpResponse, name: string): string | undefined {
  return response.headers[name.toLowerCase()] ?? response.headers[name];
}

export async function fetchTransport(request: HttpRequest): Promise<HttpResponse> {
  let current = request;
  for (let attempt = 0; attempt < 6; attempt++) {
    apiUrl(current.url);
    const response = await fetch(current.url, {
      method: current.method,
      headers: current.headers,
      body: current.body as BodyInit | undefined,
      redirect: "manual",
    });
    const result = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: new Uint8Array(await response.arrayBuffer()),
    };
    if (!REDIRECTS.has(response.status)) return result;
    const location = response.headers.get("location");
    if (!location) return result;
    const url = apiUrl(new URL(location, current.url).toString());
    current = redirectRequest(current, url, response.status);
  }
  throw new Error("gh: too many API redirects");
}

function redirectRequest(request: HttpRequest, url: string, status: number): HttpRequest {
  if (status !== 303) return { ...request, url };
  return { method: "GET", url, headers: request.headers };
}

function encodeBody(body: ApiRequest["body"]): Uint8Array | undefined {
  if (body === undefined || body instanceof Uint8Array) return body;
  return new TextEncoder().encode(JSON.stringify(body));
}

function mergeHeaders(
  custom: Readonly<Record<string, string>> | undefined,
  token: string,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `token ${token}`,
    "User-Agent": "gh-waffle",
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  for (const [name, value] of Object.entries(custom ?? {})) {
    const previous = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    if (previous) delete headers[previous];
    headers[name] = value;
  }
  return headers;
}

function httpErrorMessage(response: HttpResponse): string {
  let message = `HTTP ${response.status}`;
  try {
    const body = object(parseJson(response.body), "error response");
    if (typeof body.message === "string") message = body.message;
  } catch {
    // GitHub's status remains useful when an error response has no JSON message.
  }
  return `gh: ${message} (HTTP ${response.status})`;
}

export function responseText(response: HttpResponse): string {
  return decode(response.body);
}
