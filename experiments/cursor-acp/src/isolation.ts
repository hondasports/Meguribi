import path from "node:path";

export const CONFIG_SOURCE_ORDER = ["user", "project", "local", "cli"] as const;
export type ConfigSource = (typeof CONFIG_SOURCE_ORDER)[number];

const FORWARDED_ENVIRONMENT_KEYS = new Set([
  "ComSpec",
  "LANG",
  "Path",
  "PATH",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR"
]);

export interface IsolatedEnvironment {
  root: string;
  home: string;
  userProfile: string;
  appData: string;
  localAppData: string;
  xdgConfigHome: string;
  xdgDataHome: string;
  env: NodeJS.ProcessEnv;
}

export function buildIsolatedEnvironment(root: string, baseEnvironment: NodeJS.ProcessEnv = process.env): IsolatedEnvironment {
  const resolvedRoot = path.resolve(root);
  const home = path.join(resolvedRoot, "home");
  const userProfile = path.join(resolvedRoot, "user-profile");
  const appData = path.join(resolvedRoot, "app-data");
  const localAppData = path.join(resolvedRoot, "local-app-data");
  const xdgConfigHome = path.join(resolvedRoot, "xdg-config");
  const xdgDataHome = path.join(resolvedRoot, "xdg-data");
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (FORWARDED_ENVIRONMENT_KEYS.has(key) && value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: userProfile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome
  });

  return { root: resolvedRoot, home, userProfile, appData, localAppData, xdgConfigHome, xdgDataHome, env };
}

export function configSourcePath(root: string, source: ConfigSource): string {
  const relative = source === "project"
    ? path.join(".devin", "config.json")
    : source === "local"
      ? path.join(".devin", "config.local.json")
      : source === "user"
        ? "user-config.json"
        : "cli-config.json";
  return path.join(root, relative).split(path.sep).join("/");
}
