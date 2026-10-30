import type { HttpResponse } from "./types.ts";

export class GhError extends Error {
  readonly exit: number;
  constructor(message: string, exit = 1) {
    super(message);
    this.name = "GhError";
    this.exit = exit;
  }
}

export class HttpError extends GhError {
  readonly response: HttpResponse;
  constructor(message: string, response: HttpResponse) {
    super(message);
    this.name = "HttpError";
    this.response = response;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
