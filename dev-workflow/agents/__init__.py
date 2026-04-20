"""Agent backend factory."""

from __future__ import annotations

from agents.base import AgentBackend
from agents.claude import ClaudeBackend
from agents.codex import CodexBackend


def get_agent_backend(name: str) -> AgentBackend:
    """Create an agent backend by configured name."""
    normalized = (name or "").strip().lower()
    if normalized == "claude":
        return ClaudeBackend()
    if normalized == "codex":
        return CodexBackend()
    raise ValueError(f"Unsupported agent backend: {name!r}")
