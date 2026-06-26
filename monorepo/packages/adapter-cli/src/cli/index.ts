#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  createAdapterCliFailureResult,
  processExitCodeForResult,
  runAdapterCliRequest
} from "../executor/index.js";
import { parseAdapterCliRequestJson } from "../parser/index.js";
import type { AdapterCliResult } from "../protocol/index.js";

interface RunCommandOptions {
  request: string;
  result: string;
  pretty: boolean;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] !== "run") {
    process.stderr.write(usage());
    return 1;
  }

  const parsed = parseRunArgs(argv.slice(1));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${usage()}`);
    return 1;
  }

  const requestText = await readRequestOrFailure(parsed.options.request);
  if (!requestText.ok) {
    const result = createAdapterCliFailureResult("unknown", {
      code: "INVALID_INPUT",
      message: requestText.error
    });
    await writeResult(parsed.options.result, result, parsed.options.pretty);
    return processExitCodeForResult(result);
  }

  const request = parseAdapterCliRequestJson(requestText.text);
  if (!request.ok) {
    const result = createAdapterCliFailureResult("unknown", request.error);
    await writeResult(parsed.options.result, result, parsed.options.pretty);
    return processExitCodeForResult(result);
  }

  const result = await runAdapterCliRequest(request.request);
  await writeResult(parsed.options.result, result, parsed.options.pretty);
  return processExitCodeForResult(result);
}

function parseRunArgs(argv: string[]): { ok: true; options: RunCommandOptions } | { ok: false; error: string } {
  const options: RunCommandOptions = {
    request: "-",
    result: "-",
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--request") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { ok: false, error: "--request requires a value." };
      }
      options.request = value;
      index += 1;
      continue;
    }

    if (arg === "--result") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { ok: false, error: "--result requires a value." };
      }
      options.result = value;
      index += 1;
      continue;
    }

    if (arg === "--pretty") {
      options.pretty = true;
      continue;
    }

    return { ok: false, error: `Unknown argument: ${arg}.` };
  }

  return { ok: true, options };
}

async function readRequest(path: string): Promise<string> {
  if (path !== "-") {
    return readFile(path, "utf8");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readRequestOrFailure(path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    return { ok: true, text: await readRequest(path) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Request input could not be read."
    };
  }
}

async function writeResult(path: string, result: AdapterCliResult, pretty: boolean): Promise<void> {
  const text = `${JSON.stringify(result, undefined, pretty ? 2 : 0)}\n`;
  if (path === "-") {
    process.stdout.write(text);
    return;
  }

  await writeFile(path, text, "utf8");
}

function usage(): string {
  return [
    "Usage:",
    "  agentflow-adapter-cli run --request <request.json|-> --result <result.json|-> [--pretty]",
    ""
  ].join("\n");
}

if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(error instanceof Error ? `${error.message}\n` : "Unknown adapter-cli failure.\n");
      process.exitCode = 1;
    });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}
