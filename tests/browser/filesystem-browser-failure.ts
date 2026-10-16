// A real worker module-load failure; the production page controller must revoke all clients.
throw new Error("intentional filesystem worker load failure");
export {};
