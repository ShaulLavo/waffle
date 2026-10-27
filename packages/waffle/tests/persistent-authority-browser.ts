import { FilesystemError } from "../core/filesystem";
import { ResidentChannel, residentDescriptor } from "../fs/publication-attachment";
import { control as existingControl } from "./publication-cross-tab-browser";

async function staleDescriptor(value: unknown): Promise<number> {
  const descriptor = residentDescriptor(value);
  const channel = new ResidentChannel(descriptor.workspace);
  try {
    await channel.call("open", descriptor);
    await channel.call("closeConnection", null);
    return 0;
  } catch (error) {
    if (!(error instanceof FilesystemError)) throw error;
    return error.errno;
  } finally {
    channel.close();
  }
}

/** @browserEntry Invoked by the persistent authority runner through its bundled URL. */
export async function control(operation: string, value?: unknown): Promise<unknown> {
  if (operation === "staleDescriptor") return staleDescriptor(value);
  const result = await existingControl(operation, value);
  return result instanceof Uint8Array ? Array.from(result) : result;
}
