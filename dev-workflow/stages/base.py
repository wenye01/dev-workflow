"""Abstract base class for all workflow stage units."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from scripts.models import (
    AgentContext,
    StageConfig,
    StageContext,
    StageName,
    StageOutput,
    ValidationResult,
)


class BaseStage(ABC):
    """Abstract base class for all workflow stage units.

    Every stage must implement this interface. The orchestrator calls these
    methods in order: validate_input -> build_agent_context -> execute ->
    validate_output.
    """

    @property
    @abstractmethod
    def name(self) -> StageName:
        """Stage identifier."""
        ...

    @abstractmethod
    def validate_input(self, context: StageContext) -> ValidationResult:
        """Validate that required inputs are present and well-formed.

        Args:
            context: Contains workflow state, spec path, worktree path.

        Returns:
            ValidationResult with is_valid flag and any error messages.
        """
        ...

    @abstractmethod
    def build_agent_context(self, context: StageContext) -> AgentContext:
        """Assemble the curated context for this stage's agent invocation.

        Args:
            context: Contains workflow state, spec path, worktree path.

        Returns:
            AgentContext with stage-specific information set.
        """
        ...

    @abstractmethod
    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        """Execute the stage by invoking the agent.

        Args:
            context: Workflow state and paths.
            config: Per-stage configuration (timeout, agent backend, etc.).

        Returns:
            StageOutput with verdict, artifacts, and next stage hint.
        """
        ...

    @abstractmethod
    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        """Validate that the agent produced expected output files/content.

        Args:
            output: The StageOutput from execution.
            worktree_path: Path to the worktree where artifacts should exist.

        Returns:
            ValidationResult with is_valid flag and any error messages.
        """
        ...

    @classmethod
    def validate_contract(cls) -> list[str]:
        """Verify this stage passes BaseStage interface compliance.

        Returns:
            List of validation errors. Empty list means compliant.
        """
        errors = []
        required_methods = [
            "validate_input", "build_agent_context", "execute", "validate_output",
        ]
        for method in required_methods:
            if not hasattr(cls, method):
                errors.append(f"Missing method: {method}")

        # Check name property
        instance_methods = [m for m in dir(cls) if not m.startswith("_")]
        if "name" not in instance_methods and "name" not in cls.__dict__:
            errors.append("Missing property: name")

        return errors
