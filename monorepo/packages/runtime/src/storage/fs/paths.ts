import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";

import { FsStoreError } from "./errors.js";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;

export interface FsStorageOptions {
  rootDir: string;
}

export function normalizeRootDir(rootDir: string): string {
  return resolve(rootDir);
}

export function runDirectory(rootDir: string, run_id: string): string {
  return join(rootDir, "runs", safePathSegment(run_id, "run_id"));
}

export function runRecordPath(rootDir: string, run_id: string): string {
  return join(runDirectory(rootDir, run_id), "run.json");
}

export function eventLogPath(rootDir: string, run_id: string): string {
  return join(runDirectory(rootDir, run_id), "events.jsonl");
}

export function artifactsDirectory(rootDir: string, run_id: string): string {
  return join(runDirectory(rootDir, run_id), "artifacts");
}

export function artifactPath(rootDir: string, run_id: string, ref: string): string {
  return join(artifactsDirectory(rootDir, run_id), `${escapeStorageKey(ref)}.json`);
}

export function activationsDirectory(rootDir: string, run_id: string): string {
  return join(runDirectory(rootDir, run_id), "activations");
}

export function activationPath(rootDir: string, run_id: string, activation_id: string): string {
  return join(activationsDirectory(rootDir, run_id), `${escapeStorageKey(activation_id)}.json`);
}

export function blobsDirectory(rootDir: string, run_id: string): string {
  return join(runDirectory(rootDir, run_id), "blobs");
}

export function diagnosticsDirectory(rootDir: string, run_id: string): string {
  return join(runDirectory(rootDir, run_id), "diagnostics");
}

export function writerLockPath(rootDir: string, run_id: string): string {
  return join(runDirectory(rootDir, run_id), ".writer.lock");
}

export function escapeStorageKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function unescapeStorageKey(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safePathSegment(value: string, label: string): string {
  if (value.length === 0 || value === "." || value === ".." || !SAFE_PATH_SEGMENT.test(value)) {
    throw new FsStoreError("INVALID_PATH_SEGMENT", `${label} is not a safe filesystem segment.`, {
      label,
      value
    });
  }

  return value;
}
