export const gpuAsyncId = "gpu-async: compiled command";
export type GpuAsyncEngine = "chromium" | "firefox" | "webkit" | "ios-safari";
export type GpuAsyncRequest = { engine: GpuAsyncEngine };
