import type { ServiceWorkerEntry } from "../storage-allocation.js";
import type { Reporter } from "./reporter.js";
/** Cooperative same-origin ownership, not an atomic browser compare-and-delete.
 * Keep all later finalizers running if guarded unregister refuses foreign identity.
 */
export interface OwnedServiceWorker {
  register(): Promise<ServiceWorkerRegistration>;
  controls(registration: ServiceWorkerRegistration, controller: ServiceWorker | null): boolean;
  unregister(registration: ServiceWorkerRegistration): Promise<boolean>;
}
export interface PageContext {
  readonly serviceWorker: OwnedServiceWorker | null;
  readonly fetchFixture: (path: string) => Promise<Response>;
}
export type WorkerDeclaration = { readonly caseId: string; readonly script: string };
export type WorkerAttempt =
  | { entry: ServiceWorkerEntry; state: "admitted" | "unconfirmed" }
  | { entry: ServiceWorkerEntry; state: "settled"; outcome: "registered" | "rejected" };
export function sameWorkerEntry(a: ServiceWorkerEntry, b: ServiceWorkerEntry): boolean {
  return a.name === b.name && a.clientURL === b.clientURL && a.scriptURL === b.scriptURL;
}
function workerIdentity(
  registration: ServiceWorkerRegistration,
  entry: ServiceWorkerEntry,
): boolean {
  if (registration.scope !== entry.name) return false;
  const workers = [registration.installing, registration.waiting, registration.active];
  return (
    workers.some((worker) => worker !== null) &&
    workers.every((worker) => worker === null || worker.scriptURL === entry.scriptURL)
  );
}
async function current(entry: ServiceWorkerEntry): Promise<ServiceWorkerRegistration | undefined> {
  return (await navigator.serviceWorker.getRegistrations()).find(
    (item) => item.scope === entry.name,
  );
}
/** Enumerate the CURRENT map entry. Never invoke a stale held object's unregister. */
async function deleteServiceWorker(
  entry: ServiceWorkerEntry,
  live: () => void = () => {},
): Promise<boolean> {
  live();
  const registration = await current(entry);
  live();
  if (!registration) return false;
  if (!workerIdentity(registration, entry))
    throw new Error(`Foreign or unidentified current service worker: ${entry.name}`);
  const removed = await registration.unregister();
  live();
  if (await current(entry)) throw new Error(`Service worker remains: ${entry.name}`);
  live();
  return removed;
}
let finishAttempts: readonly WorkerAttempt[] | undefined;
export function bindFinishAttempts(attempts: readonly WorkerAttempt[]): void {
  finishAttempts = attempts;
}
export async function cleanupServiceWorker(entry: ServiceWorkerEntry): Promise<void> {
  await deleteServiceWorker(entry);
  const attempt = finishAttempts?.find((item) => sameWorkerEntry(item.entry, entry));
  if (attempt?.state !== "settled")
    throw new Error(`Unjoined registration operation: ${entry.name}`);
}
export function ownedServiceWorker(
  entry: ServiceWorkerEntry,
  reporter: Reporter,
): OwnedServiceWorker {
  let attempt: Promise<ServiceWorkerRegistration> | undefined;
  let held: ServiceWorkerRegistration | undefined;
  const live = () => {
    if (
      reporter.observation.retired ||
      reporter.observation.failure ||
      location.href !== entry.clientURL
    )
      throw new Error("Worker document binding revoked");
  };
  const absent = async () => {
    live();
    if (await current(entry)) throw new Error(`Service worker scope collision: ${entry.name}`);
    live();
  };
  const register = async () => {
    await absent();
    await reporter.send({ kind: "allocation", entry });
    try {
      await absent();
    } catch (error) {
      live();
      await reporter.send({ kind: "worker-settled", entry, outcome: "rejected" });
      throw error;
    }
    let registration: ServiceWorkerRegistration;
    try {
      registration = await navigator.serviceWorker.register(entry.scriptURL, {
        scope: entry.name,
        type: "module",
      });
    } catch (error) {
      live();
      await reporter.send({ kind: "worker-settled", entry, outcome: "rejected" });
      throw error;
    }
    live();
    await reporter.send({ kind: "worker-settled", entry, outcome: "registered" });
    live();
    if (!workerIdentity(registration, entry))
      throw new Error("Returned service worker identity mismatch");
    held = registration;
    return registration;
  };
  return {
    register: () => (attempt ??= register()),
    controls(registration, controller) {
      live();
      return (
        registration === held &&
        workerIdentity(registration, entry) &&
        registration.active !== null &&
        registration.active === controller &&
        controller.scriptURL === entry.scriptURL
      );
    },
    async unregister(registration) {
      live();
      if (registration !== held || !workerIdentity(registration, entry))
        throw new Error("Held service worker identity mismatch");
      return deleteServiceWorker(entry, live);
    },
  };
}
