import type { GuestLauncher, RuntimeProcessContext } from "waffle";

/** The qualified CPython startup patch establishes cwd from PWD. */
export function pythonLaunchContext<T extends Pick<RuntimeProcessContext, "request">>(
  context: T,
): T {
  return {
    ...context,
    request: {
      ...context.request,
      env: { ...context.request.env, PWD: context.request.cwd },
    },
  };
}

/** Wrap the caller's existing launcher only for the Python installation. */
export function pythonLauncher(launcher: GuestLauncher): GuestLauncher {
  return (context, service) => launcher(pythonLaunchContext(context), service);
}
