export function comparisonEnvironment(options: {
  readonly root: string;
  readonly authenticated: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: options.root,
    GH_CONFIG_DIR: options.root,
    NO_COLOR: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    LANG: "C.UTF-8",
  };
  if (options.authenticated) env.GH_TOKEN = "GH_CONTRACT_FAKE_TOKEN_NEVER_VALID";
  return env;
}
