"""Abstract interface for agent CLI backends."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from scripts.models import AgentResult


class AgentBackend(ABC):
    """Abstract interface for agent CLI backends.

    Concrete implementations handle subprocess invocation of specific
    agent CLIs (Claude Code, Codex, etc.).
    """

    @abstractmethod
    def invoke(
        self,
        prompt: str,
        working_dir: Path,
        timeout: int,
        output_schema: Path | None = None,
        debug_log_dir: Path | None = None,
    ) -> AgentResult:
        """Invoke the agent CLI as a subprocess.

        Args:
            prompt: The full prompt to send to the agent.
            working_dir: Working directory for the subprocess.
            timeout: Wall-clock timeout in seconds.
            output_schema: Path to a JSON Schema file for structured output.
            debug_log_dir: If set, save debug logs (prompt, stdout, stderr) to this dir.

        Returns:
            AgentResult with exit code, stdout, and parsed output.
        """
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Backend identifier for logging and config."""
        ...
