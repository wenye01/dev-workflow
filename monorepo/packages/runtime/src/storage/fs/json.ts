import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isErrorWithCode } from "./errors.js";

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function ensureJsonlFile(path: string): Promise<void> {
  await ensureDirectory(dirname(path));
  const handle = await open(path, "a");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

export async function readJsonFile(path: string): Promise<unknown | undefined> {
  const text = await readTextFile(path);
  if (text === undefined) {
    return undefined;
  }

  return JSON.parse(text) as unknown;
}

export async function listJsonFiles(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(path, entry.name))
      .sort();
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${canonicalJson(value)}\n`);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  const handle = await open(path, "a");
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteText(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  await ensureDirectory(directory);
  const tempPath = join(directory, `.${randomUUID()}.tmp`);
  let created = false;

  try {
    const handle = await open(tempPath, "wx");
    created = true;
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, path);
    await fsyncDirectoryBestEffort(directory);
  } catch (error) {
    if (created) {
      await rm(tempPath, { force: true });
    }

    throw error;
  }
}

export function computeCanonicalContentHash(value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `sha256-${digest}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) {
      sorted[key] = canonicalize(item);
    }
  }

  return sorted;
}

async function fsyncDirectoryBestEffort(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not available on every platform.
  }
}
