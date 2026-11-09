import { configSchema } from "../contracts/config.ts";

const common = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
];
const windows = [
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "HOMEDRIVE",
  "HOMEPATH",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "WINDIR",
];

export function setupEnvironment(
  names: readonly string[],
  root: string,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const selected = configSchema.shape.passEnv.parse([...names]);
  if (selected.some((name) => name.startsWith("GIT_")))
    throw new Error("Setup passEnv cannot override Git control variables");
  const result: Record<string, string> = {};
  for (const key of [...common, ...(platform === "win32" ? windows : []), ...selected]) {
    const value = inherited[key];
    if (value !== undefined) result[key] = value;
  }
  return {
    ...result,
    PINATA_ROOT: root,
    PINATA_AGENT: "1",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}
export function setupShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } {
  if (!command.trim()) throw new Error("Setup command is empty");
  return platform === "win32"
    ? {
        executable: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
        args: ["/d", "/s", "/c", command],
      }
    : { executable: "sh", args: ["-c", command] };
}
