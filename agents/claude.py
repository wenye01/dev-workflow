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
        max_turns: int = 30,
        max_budget_usd: float = 10.0,
        output_schema: Path | None = None,
    ) -> AgentResult:
        """Invoke Claude Code CLI with the given prompt."""
        cmd = [
            "claude", "-p", prompt,
            "--output-format", "json",
            "--max-turns", str(max_turns),
            "--max-budget-usd", str(max_budget_usd),
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

        parsed = None
        if stdout.strip():
            try:
                parsed = json.loads(stdout.strip())
            except json.JSONDecodeError:
                pass

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
