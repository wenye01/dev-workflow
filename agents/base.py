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
        max_turns: int = 30,
        max_budget_usd: float = 10.0,
        output_schema: Path | None = None,
    ) -> AgentResult:
        """Invoke the agent CLI as a subprocess.

        Args:
            prompt: The full prompt to send to the agent.
            working_dir: Working directory for the subprocess.
            timeout: Wall-clock timeout in seconds.
            max_turns: Maximum number of agent tool-use turns.
            max_budget_usd: Maximum budget in USD.
            output_schema: Path to a JSON Schema file for structured output.

        Returns:
            AgentResult with exit code, stdout, and parsed output.
        """
        ...

    @property
    @abstractmethod
    def name(self) -> str:
        """Backend identifier for logging and config."""
        ...
