import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../contracts/digest.ts";
import { DomainError } from "../contracts/common.ts";
import { publishImmutable, replaceProjection } from "../storage/io.ts";
import {
  ipcCredentialsSchema,
  ipcLinkSchema,
  type IpcCredentials,
  type IpcLink,
  type IpcRole,
} from "./protocol.ts";

export function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function publishIpcLink(
  directory: string,
  link: IpcLink,
  allowControl: boolean,
): Promise<IpcCredentials> {
  const root = await realpath(directory);
  const privateDirectory = join(root, "ipc");
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  if ((await lstat(privateDirectory)).isSymbolicLink())
    throw new DomainError("conflict", "IPC credential directory cannot be a symbolic link");
  await chmod(privateDirectory, 0o700);
  const credentials = ipcCredentialsSchema.parse({
    schemaVersion: 2,
    run: link.run,
    serverId: link.serverId,
    ownerEpoch: link.ownerEpoch,
    viewer: randomBytes(32).toString("hex"),
    ...(allowControl ? { control: randomBytes(32).toString("hex") } : {}),
  });
  await publishImmutable(
    join(privateDirectory, link.credentialFile),
    Buffer.from(canonicalJson(credentials)),
    "ipc-credentials",
  );
  await replaceProjection(
    join(privateDirectory, "link.json"),
    Buffer.from(canonicalJson(link)),
    "ipc-link",
  );
  return credentials;
}
export async function readIpcLink(directory: string): Promise<IpcLink> {
  return ipcLinkSchema.parse(
    JSON.parse(await readFile(join(directory, "ipc", "link.json"), "utf8")),
  );
}
export async function readIpcCredentials(
  directory: string,
  role: IpcRole,
): Promise<{ link: IpcLink; token: string }> {
  const link = await readIpcLink(directory);
  const path = join(directory, "ipc", link.credentialFile);
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new DomainError("capability_denied", "IPC credentials must be a private regular file");
  const credentials = ipcCredentialsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (
    credentials.run !== link.run ||
    credentials.serverId !== link.serverId ||
    credentials.ownerEpoch !== link.ownerEpoch
  )
    throw new DomainError(
      "capability_denied",
      "IPC credentials do not match the selected run endpoint",
    );
  const token = credentials[role];
  if (!token)
    throw new DomainError("capability_denied", "This run does not expose control credentials");
  return { link, token };
}
