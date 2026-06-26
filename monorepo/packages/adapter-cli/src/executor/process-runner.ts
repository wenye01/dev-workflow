import { spawn } from "node:child_process";

import type { AdapterCliError } from "../protocol/index.js";

export interface ProcessRunRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout_ms?: number;
  cancel_signal?: AbortSignal;
}

export interface ProcessRunResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out?: boolean;
  cancelled?: boolean;
  signal?: string;
  error?: AdapterCliError;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    return new Promise((resolve) => {
      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: {
          ...process.env,
          ...request.env
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let cancelled = false;

      const finish = (result: ProcessRunResult): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        request.cancel_signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const timeout =
        request.timeout_ms === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
            }, request.timeout_ms);

      const onAbort = (): void => {
        cancelled = true;
        child.kill("SIGTERM");
      };

      request.cancel_signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        const commandNotFound = error.code === "ENOENT";
        finish({
          exit_code: commandNotFound ? 127 : 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          error: {
            code: commandNotFound ? "COMMAND_NOT_FOUND" : "BACKEND_FAILED",
            message: commandNotFound
              ? `Backend command not found: ${request.command}.`
              : `Backend process failed to start: ${error.message}.`,
            details: {
              command: request.command,
              error_code: error.code ?? "UNKNOWN"
            }
          }
        });
      });

      child.on("close", (code, signal) => {
        if (timedOut) {
          finish({
            exit_code: 124,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            timed_out: true,
            signal: signal ?? undefined,
            error: {
              code: "TIMEOUT",
              message: `Backend process timed out after ${request.timeout_ms}ms.`,
              retryable: true
            }
          });
          return;
        }

        if (cancelled) {
          finish({
            exit_code: 130,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            cancelled: true,
            signal: signal ?? undefined,
            error: {
              code: "CANCELLED",
              message: "Backend process was cancelled."
            }
          });
          return;
        }

        finish({
          exit_code: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          signal: signal ?? undefined
        });
      });

      if (request.stdin !== undefined) {
        child.stdin.end(request.stdin);
      } else {
        child.stdin.end();
      }
    });
  }
}
