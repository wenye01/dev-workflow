"""Claude Code CLI agent backend."""

from __future__ import annotations

import json
import logging
import subprocess
from datetime import datetime
from pathlib import Path

import psutil

from agents.base import AgentBackend
from scripts.models import AgentResult

logger = logging.getLogger(__name__)


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
        model: str | None = None,
        output_schema: Path | None = None,
        debug_log_dir: Path | None = None,
    ) -> AgentResult:
        """Invoke Claude Code CLI with the given prompt.

        When output_schema is provided, uses --json-schema for structured outputs.
        Follows the Agent SDK pattern: checks subtype for success/error,
        extracts structured_output or result field. Errors out if JSON is expected
        but not returned — no degradation.
        """
        # Prepare debug log directory
        if debug_log_dir is not None:
            debug_log_dir.mkdir(parents=True, exist_ok=True)

        cmd = [
            "claude", "-p", prompt,
            "--output-format", "json",
            "--dangerously-skip-permissions",
        ]

        if model:
            cmd.extend(["--model", model])

        # Add debug flags for traceability
        if debug_log_dir is not None:
            debug_file = debug_log_dir / "claude-debug.log"
            cmd.extend(["--debug-file", str(debug_file)])
            cmd.append("--verbose")
            logger.info("Debug log will be written to: %s", debug_file)

        if output_schema is not None:
            schema_json = output_schema.read_text(encoding="utf-8")
            cmd.extend(["--json-schema", schema_json])

        # Log invocation details
        logger.info("=" * 60)
        logger.info("Claude CLI invocation: working_dir=%s, timeout=%ds, model=%s", working_dir, timeout, model)
        logger.info("Command (first 500 chars): %s", " ".join(cmd)[:500])
        logger.info("Prompt length: %d chars", len(prompt))
        logger.info("Output schema: %s", output_schema)

        # Save prompt to debug log dir
        if debug_log_dir is not None:
            (debug_log_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
            (debug_log_dir / "command.txt").write_text(
                json.dumps({"cmd": [c if len(c) < 200 else c[:200] + "..." for c in cmd],
                            "cwd": str(working_dir), "timeout": timeout, "model": model}, indent=2),
                encoding="utf-8",
            )

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
            logger.info("Agent process started: PID=%d", proc.pid)
        except FileNotFoundError:
            logger.error("claude CLI not found in PATH")
            return AgentResult(
                exit_code=-2,
                stderr="claude CLI not found. Install Claude Code CLI.",
            )

        start_time = datetime.now()
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            elapsed = (datetime.now() - start_time).total_seconds()
            logger.error("Agent timed out after %.1fs (limit=%ds)", elapsed, timeout)
            _kill_process_tree(proc)
            return AgentResult(exit_code=-1, timed_out=True, stderr="Agent timed out")

        elapsed = (datetime.now() - start_time).total_seconds()
        logger.info("Agent process finished: exit_code=%d, elapsed=%.1fs", proc.returncode, elapsed)
        logger.info("stdout length: %d chars, stderr length: %d chars", len(stdout), len(stderr))

        # Save raw output to debug log dir
        if debug_log_dir is not None:
            (debug_log_dir / "stdout.txt").write_text(stdout, encoding="utf-8")
            (debug_log_dir / "stderr.txt").write_text(stderr, encoding="utf-8")
            (debug_log_dir / "exit_code.txt").write_text(str(proc.returncode), encoding="utf-8")
            logger.info("Raw output saved to: %s", debug_log_dir)

        # Agent must produce output
        if not stdout.strip():
            logger.error("Agent returned empty stdout. stderr: %s", stderr[:1000])
            return AgentResult(
                exit_code=proc.returncode or 1,
                stdout=stdout,
                stderr=stderr or "Agent returned empty output",
            )

        # Parse CLI wrapper JSON (--output-format json wraps agent response)
        try:
            raw = json.loads(stdout.strip())
        except json.JSONDecodeError:
            logger.error("Agent output is not valid JSON. First 500 chars: %s", stdout[:500])
            return AgentResult(
                exit_code=proc.returncode or 1,
                stdout=stdout,
                stderr=f"Agent output is not valid JSON: {stdout[:500]}",
            )

        logger.info("Parsed JSON keys: %s", list(raw.keys()))

        # Check CLI-level errors
        if raw.get("is_error"):
            error_msg = raw.get("result", "Unknown CLI error")
            logger.error("CLI-level error: %s", error_msg)
            return AgentResult(
                exit_code=1,
                stdout=stdout,
                stderr=str(error_msg),
            )

        # Check structured output error subtype (Agent SDK pattern)
        subtype = raw.get("subtype", "")
        if subtype == "error_max_structured_output_retries":
            logger.error("Agent failed structured output after max retries")
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
            logger.info("Extracted structured_output from response")
        else:
            result_text = raw.get("result", "")

            if isinstance(result_text, dict):
                # Already a dict (some CLI versions return parsed JSON)
                parsed = result_text
                logger.info("Result field is already a dict")
            elif isinstance(result_text, str) and result_text.strip():
                # Strip markdown fences (minimal preprocessing)
                cleaned = _strip_markdown_fences(result_text)
                try:
                    parsed = json.loads(cleaned)
                    if not isinstance(parsed, dict):
                        parsed = {"result": parsed}
                    logger.info("Parsed result text as JSON, keys: %s", list(parsed.keys()))
                except json.JSONDecodeError:
                    if output_schema is not None:
                        logger.error(
                            "Schema required but result is not JSON. First 500 chars: %s",
                            result_text[:500],
                        )
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
                    logger.info("No schema required, storing result as plain text (%d chars)", len(result_text))
                    parsed = {"result": result_text}

        logger.info("Agent invocation succeeded. Parsed output keys: %s",
                     list(parsed.keys()) if parsed else "None")
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
