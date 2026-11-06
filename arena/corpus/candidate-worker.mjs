import { createReadStream, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deserialize, serialize } from "node:v8";

// This process contains candidate code. It reports function observations, never
// assertions or scores. fd 3/4 are private pipes, not the parent's scoring fd.
const MAX_FRAME_BYTES = 1024 * 1024;
const exit = process.exit.bind(process);
const freeze = Object.freeze;
const ownKeys = Object.keys;
const getDescriptor = Object.getOwnPropertyDescriptor;
const apply = Reflect.apply;
const isArray = Array.isArray;
const isSafeInteger = Number.isSafeInteger;
const hasOwn = Object.hasOwn;
const bufferFrom = Buffer.from.bind(Buffer);
const bufferConcat = Buffer.concat.bind(Buffer);
const bufferAlloc = Buffer.allocUnsafe.bind(Buffer);
const copyBuffer = Function.call.bind(Buffer.prototype.copy);
const readLength = Function.call.bind(Buffer.prototype.readUInt32BE);
const writeLength = Function.call.bind(Buffer.prototype.writeUInt32BE);
const sliceBuffer = Function.call.bind(Buffer.prototype.subarray);
const WeakSetType = WeakSet;
const weakHas = Function.call.bind(WeakSet.prototype.has);
const weakAdd = Function.call.bind(WeakSet.prototype.add);
const stringify = String;
const sliceString = Function.call.bind(String.prototype.slice);
const modules = Object.create(null);
let buffered = bufferFrom([]);
let nextId = 0;
let busy = false;
let ready = false;

function send(message) {
  const payload = serialize(message);
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Candidate result exceeds byte limit");
  const frame = bufferAlloc(payload.length + 4);
  writeLength(frame, payload.length, 0);
  copyBuffer(payload, frame, 4);
  let offset = 0;
  while (offset < frame.length) offset += writeSync(4, frame, offset, frame.length - offset);
}

function deepFreeze(value, seen = new WeakSetType()) {
  if (value === null || typeof value !== "object" || weakHas(seen, value)) return;
  weakAdd(seen, value);
  for (const key of ownKeys(value)) {
    const descriptor = getDescriptor(value, key);
    if (descriptor && hasOwn(descriptor, "value")) deepFreeze(descriptor.value, seen);
  }
  freeze(value);
}

async function receive(message) {
  if (
    !ready ||
    busy ||
    message?.protocolVersion !== 1 ||
    !isSafeInteger(message.id) ||
    message.id !== nextId++
  )
    exit(2);
  if (message.type === "shutdown") {
    send({ protocolVersion: 1, type: "done", id: message.id });
    exit(0);
  }
  if (
    message.type !== "call" ||
    typeof message.module !== "string" ||
    typeof message.method !== "string" ||
    !isArray(message.args)
  )
    exit(2);
  busy = true;
  let response;
  try {
    deepFreeze(message.args);
    const module = modules[message.module];
    if (
      !module ||
      !hasOwn(module, message.method) ||
      typeof module[message.method] !== "function"
    ) {
      throw new TypeError(`Missing candidate function ${message.module}.${message.method}`);
    }
    const value = await apply(module[message.method], module, message.args);
    response = {
      protocolVersion: 1,
      type: "result",
      id: message.id,
      ok: true,
      args: message.args,
      value,
    };
  } catch (error) {
    response = {
      protocolVersion: 1,
      type: "result",
      id: message.id,
      ok: false,
      error: {
        name: typeof error?.name === "string" ? sliceString(error.name, 0, 100) : "Error",
        message: sliceString(
          typeof error?.message === "string" ? error.message : stringify(error),
          0,
          1200,
        ),
      },
    };
  }
  send(response);
  busy = false;
}

const input = createReadStream(null, { fd: 3, autoClose: false });
input.on("data", (chunk) => {
  try {
    buffered = bufferConcat([buffered, chunk]);
    while (buffered.length >= 4) {
      const size = readLength(buffered, 0);
      if (size === 0 || size > MAX_FRAME_BYTES) exit(2);
      if (buffered.length < size + 4) break;
      const payload = sliceBuffer(buffered, 4, size + 4);
      buffered = sliceBuffer(buffered, size + 4);
      receive(deserialize(payload)).catch(() => exit(2));
    }
  } catch {
    exit(2);
  }
});
input.on("end", () => exit(2));
input.on("error", () => exit(2));

try {
  const candidateDir = process.argv[2];
  const names = JSON.parse(process.argv[3]);
  for (const name of names) {
    modules[name] = await import(pathToFileURL(resolve(candidateDir, `${name}.mjs`)).href);
  }
  ready = true;
  send({ protocolVersion: 1, type: "ready" });
} catch {
  exit(2);
}
