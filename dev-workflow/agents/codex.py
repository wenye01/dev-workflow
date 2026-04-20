"""Codex CLI agent backend."""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path

import psutil

from agents.base import AgentBackend
from scripts.models import AgentResult

logger = logging.getLogger(__name__)


class CodexBackend(AgentBackend):
    """Invokes Codex CLI as a subprocess for agent-based stage execution."""

    @property
    def name(self) -> str:
        return "codex"

    def invoke(
        self,
        prompt: str,
        working_dir,
        timeout: int,
        output_schema: Path | None = None,
        debug_log_dir: Path | None = None,
    ) -> AgentResult:
        """Invoke Codex CLI with the given prompt."""
        if debug_log_dir is not None:
            debug_log_dir.mkdir(parents=True, exist_ok=True)

        cmd = [
            "codex", "exec", prompt,
            "--full-auto",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
        ]

        if output_schema is not None:
            cmd.extend(["--output-schema", str(output_schema)])

        env = os.environ.copy()
        env["RUST_LOG"] = "debug"

        logger.info("Codex CLI invocation: working_dir=%s, timeout=%ds", working_dir, timeout)
        logger.info("Prompt length: %d chars", len(prompt))
        logger.info("Codex verbose logging enabled via RUST_LOG=%s", env["RUST_LOG"])

        if debug_log_dir is not None:
            (debug_log_dir / "prompt.txt").write_text(prompt, encoding="utf-8")

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(working_dir),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            logger.info("Codex process started: PID=%d", proc.pid)
        except FileNotFoundError:
            logger.error("codex CLI not found in PATH")
            return AgentResult(
                exit_code=-2,
                stderr="codex CLI not found. Install Codex CLI.",
            )

        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            logger.error("Codex agent timed out after %ds", timeout)
            _kill_process_tree(proc)
            return AgentResult(exit_code=-1, timed_out=True, stderr="Agent timed out")

        logger.info("Codex process finished: exit_code=%d, stdout=%d chars, stderr=%d chars",
                     proc.returncode, len(stdout), len(stderr))

        if debug_log_dir is not None:
            (debug_log_dir / "stdout.txt").write_text(stdout, encoding="utf-8")
            (debug_log_dir / "stderr.txt").write_text(stderr, encoding="utf-8")

        if not stdout.strip():
            logger.error("Codex returned empty stdout. stderr: %s", stderr[:1000])
            return AgentResult(
                exit_code=proc.returncode or 1,
                stdout=stdout,
                stderr=stderr or "Agent returned empty output",
            )

        parsed_lines: list[dict] = []
        for line in stdout.splitlines():
            text = line.strip()
            if not text:
                continue
            try:
                obj = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                parsed_lines.append(obj)

        cli_error: str | None = None
        payload: dict | None = None
        for obj in reversed(parsed_lines):
            if obj.get("is_error") is True:
                cli_error = str(obj.get("result") or obj.get("error") or "Codex CLI reported an error")
                break
            if isinstance(obj.get("structured_output"), dict):
                payload = obj["structured_output"]
                break

            result = obj.get("result")
            if isinstance(result, dict):
                payload = result
                break
            if isinstance(result, str) and result.strip():
                try:
                    decoded = json.loads(_strip_markdown_fences(result))
                except json.JSONDecodeError:
                    continue
                if isinstance(decoded, dict):
                    payload = decoded
                    break
                payload = {"result": decoded}
                break

        if cli_error is not None:
            return AgentResult(
                exit_code=1,
                stdout=stdout,
                stderr=cli_error,
            )

        if output_schema is not None and payload is None:
            return AgentResult(
                exit_code=1,
                stdout=stdout,
                stderr="Codex did not return valid structured JSON output",
            )

        return AgentResult(
            exit_code=proc.returncode or 0,
            stdout=stdout,
            stderr=stderr,
            parsed_output=payload,
        )


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """Kill process and all children (essential on Windows)."""
    try:
        parent = psutil.Process(proc.pid)
        for child in parent.children(recursive=True):
            child.kill()
        parent.kill()
        proc.communicate()
    except (psutil.NoSuchProcess, ProcessLookupError):
        pass


def _strip_markdown_fences(text: str) -> str:
    """Strip markdown code fences from text (```json ... ``` or ``` ... ```)."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        nl = cleaned.find("\n")
        if nl != -1:
            cleaned = cleaned[nl + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].strip()
    return cleaned
