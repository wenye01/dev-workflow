"""Codex CLI agent backend."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import psutil

from agents.base import AgentBackend
from scripts.models import AgentResult


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
    ) -> AgentResult:
        """Invoke Codex CLI with the given prompt."""
        cmd = [
            "codex", "exec", prompt,
            "--full-auto",
            "--json",
            "--dangerously-bypass-approvals-and-sandbox",
        ]

        if output_schema is not None:
            cmd.extend(["--output-schema", str(output_schema)])

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(working_dir),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
        except FileNotFoundError:
            return AgentResult(
                exit_code=-2,
                stderr="codex CLI not found. Install Codex CLI.",
            )

        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_process_tree(proc)
            return AgentResult(exit_code=-1, timed_out=True, stderr="Agent timed out")

        # Parse JSONL output - take the last valid JSON line
        parsed = None
        if stdout.strip():
            lines = stdout.strip().splitlines()
            for line in reversed(lines):
                try:
                    parsed = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue

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
        proc.communicate()
    except (psutil.NoSuchProcess, ProcessLookupError):
        pass
