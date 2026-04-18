"""Claude Code CLI agent backend."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import psutil

from agents.base import AgentBackend
from scripts.models import AgentResult


class ClaudeBackend(AgentBackend):
    """Invokes Claude Code CLI as a subprocess for agent-based stage execution."""

    @property
    def name(self) -> str:
        return "claude"

    def invoke(
        self,
        prompt: str,
        working_dir,
        timeout: int,
        output_schema: Path | None = None,
    ) -> AgentResult:
        """Invoke Claude Code CLI with the given prompt.

        When output_schema is provided, uses --json-schema for structured outputs.
        Follows the Agent SDK pattern: checks subtype for success/error,
        extracts structured_output or result field. Errors out if JSON is expected
        but not returned — no degradation.
        """
        cmd = [
            "claude", "-p", prompt,
            "--output-format", "json",
            "--dangerously-skip-permissions",
        ]

        if output_schema is not None:
            schema_json = output_schema.read_text(encoding="utf-8")
            cmd.extend(["--json-schema", schema_json])

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(working_dir),
                stdin=subprocess.DEVNULL,  # CRITICAL: prevent TTY hang
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError:
            return AgentResult(
                exit_code=-2,
                stderr="claude CLI not found. Install Claude Code CLI.",
            )

        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_process_tree(proc)
            return AgentResult(exit_code=-1, timed_out=True, stderr="Agent timed out")

        # Agent must produce output
        if not stdout.strip():
            return AgentResult(
                exit_code=proc.returncode or 1,
                stdout=stdout,
                stderr=stderr or "Agent returned empty output",
            )

        # Parse CLI wrapper JSON (--output-format json wraps agent response)
        try:
            raw = json.loads(stdout.strip())
        except json.JSONDecodeError:
            return AgentResult(
                exit_code=proc.returncode or 1,
                stdout=stdout,
                stderr=f"Agent output is not valid JSON: {stdout[:500]}",
            )

        # Check CLI-level errors
        if raw.get("is_error"):
            error_msg = raw.get("result", "Unknown CLI error")
            return AgentResult(
                exit_code=1,
                stdout=stdout,
                stderr=str(error_msg),
            )

        # Check structured output error subtype (Agent SDK pattern)
        subtype = raw.get("subtype", "")
        if subtype == "error_max_structured_output_retries":
            return AgentResult(
                exit_code=1,
                stdout=stdout,
                stderr="Agent failed to produce valid structured output after max retries",
            )

        # Extract structured output
        parsed = None

        # SDK pattern: structured_output field takes priority
        if "structured_output" in raw and isinstance(raw["structured_output"], dict):
            parsed = raw["structured_output"]
        else:
            result_text = raw.get("result", "")

            if isinstance(result_text, dict):
                # Already a dict (some CLI versions return parsed JSON)
                parsed = result_text
            elif isinstance(result_text, str) and result_text.strip():
                # Strip markdown fences (minimal preprocessing)
                cleaned = _strip_markdown_fences(result_text)
                try:
                    parsed = json.loads(cleaned)
                    if not isinstance(parsed, dict):
                        parsed = {"result": parsed}
                except json.JSONDecodeError:
                    if output_schema is not None:
                        # Schema was required but agent didn't return valid JSON → error
                        return AgentResult(
                            exit_code=1,
                            stdout=stdout,
                            stderr=(
                                "Agent did not return valid JSON matching the schema. "
                                f"Raw output: {result_text[:500]}"
                            ),
                        )
                    # No schema required — plain text result is acceptable
                    parsed = {"result": result_text}

        return AgentResult(
            exit_code=proc.returncode or 0,
            stdout=stdout,
            stderr=stderr,
            parsed_output=parsed,
        )


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """Kill process and all children (essential on Windows)."""
    try:
        parent = psutil.Process(proc.pid)
        for child in parent.children(recursive=True):
            child.kill()
        parent.kill()
        proc.communicate()  # Reap zombie
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
