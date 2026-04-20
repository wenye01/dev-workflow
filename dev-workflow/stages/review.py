"""Review stage: code review via agent with structured feedback output."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from agents import get_agent_backend
from scripts.models import (
    AgentContext,
    Issue,
    ReviewFeedback,
    Severity,
    StageConfig,
    StageContext,
    StageName,
    StageOutput,
    ValidationResult,
    Verdict,
    get_run_state_dir,
)
from scripts.output_schema import get_schema_path, validate_agent_output
from stages.base import BaseStage

logger = logging.getLogger(__name__)


class ReviewStage(BaseStage):
    """Reviews implementation code and produces structured ReviewFeedback."""

    @property
    def name(self) -> StageName:
        return StageName.REVIEW

    def validate_input(self, context: StageContext) -> ValidationResult:
        errors = []
        if not context.worktree_path.exists():
            errors.append(f"Worktree not found: {context.worktree_path}")
        if not context.spec_path.exists():
            errors.append(f"Spec file not found: {context.spec_path}")
        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def build_agent_context(self, context: StageContext) -> AgentContext:
        ctx = AgentContext(
            stage_name=self.name,
            project_context={
                "spec_path": str(context.spec_path),
                "worktree_path": str(context.worktree_path),
            },
        )

        # Load spec acceptance criteria
        if context.spec_path.exists():
            ctx.spec_content = context.spec_path.read_text(encoding="utf-8")

        # Get git changes since last review
        ctx.git_history = self._get_git_changes(context.worktree_path)

        return ctx

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        prompt = self._build_review_prompt(context)
        logger.info("Review prompt built: %d chars", len(prompt))

        try:
            result = self._invoke_agent(prompt, context, config)
        except Exception as e:
            logger.error("Review agent invocation FAILED: %s", e)
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message=str(e),
            )

        # Parse or build review feedback
        feedback = self._parse_review_result(result, context)
        logger.info("Review verdict: %s, issues: %d", feedback.verdict.value, len(feedback.issues))
        for issue in feedback.issues:
            logger.info("  Issue [%s] %s: %s", issue.severity.value, issue.category, issue.description[:100])

        # Write review-result.json
        review_path = get_run_state_dir(context.project_path, context.run_id) / "review-result.json"
        review_path.parent.mkdir(parents=True, exist_ok=True)
        review_path.write_text(feedback.model_dump_json(indent=2), encoding="utf-8")

        return StageOutput(
            stage_name=self.name,
            verdict=feedback.verdict,
            result_path=review_path,
            artifacts={"review-result": review_path},
        )

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        review_path = output.result_path if output.result_path else None
        if review_path is None or not review_path.exists():
            return ValidationResult(is_valid=False, errors=["review-result.json not found"])

        try:
            ReviewFeedback.model_validate_json(review_path.read_text(encoding="utf-8"))
        except Exception as e:
            errors.append(f"review-result.json is not valid JSON: {e}")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def _build_review_prompt(self, context: StageContext) -> str:
        """Build review prompt using template."""
        from context.builder import load_project_context, render_template

        agent_ctx = context.agent_context or self.build_agent_context(context)
        spec_text = agent_ctx.spec_content
        git_changes = agent_ctx.git_history or self._get_git_changes(context.worktree_path)
        project_ctx = load_project_context(context.worktree_path)

        return render_template(self.name, {
            **project_ctx,
            "spec_content": spec_text,
            "git_changes": git_changes,
            "feedback": "",
        })

    def _get_git_changes(self, worktree_path: Path) -> str:
        """Get git diff of changes for review."""
        import subprocess
        try:
            result = subprocess.run(
                ["git", "diff", "HEAD~1"],
                cwd=str(worktree_path),
                capture_output=True,
                text=True,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout[:5000]  # Limit size
        except Exception:
            pass
        return ""

    def _invoke_agent(self, prompt: str, context: StageContext, config: StageConfig) -> dict:
        backend = get_agent_backend(config.agent_backend)
        schema_path = get_schema_path("review-output")

        # Prepare debug log directory
        state_dir = get_run_state_dir(context.project_path, context.run_id)
        debug_log_dir = state_dir / "agent-logs" / f"review-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        logger.info("Review agent debug log dir: %s", debug_log_dir)

        result = backend.invoke(
            prompt=prompt,
            working_dir=context.worktree_path,
            timeout=config.timeout_seconds,
            output_schema=schema_path,
            debug_log_dir=debug_log_dir,
        )

        # Save result summary
        summary = {
            "exit_code": result.exit_code,
            "timed_out": result.timed_out,
            "stdout_length": len(result.stdout),
            "stderr_length": len(result.stderr),
            "stderr_preview": result.stderr[:2000] if result.stderr else "",
            "parsed_output_keys": list(result.parsed_output.keys()) if result.parsed_output else None,
            "timestamp": datetime.now().isoformat(),
        }
        (debug_log_dir / "result-summary.json").write_text(
            json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8",
        )

        if result.timed_out:
            raise TimeoutError(f"Review agent timed out after {config.timeout_seconds}s")
        if result.exit_code != 0:
            raise RuntimeError(f"Agent invocation failed (exit_code={result.exit_code}): {result.stderr}")
        return result.parsed_output or {}

    def _parse_review_result(self, raw: dict, context: StageContext) -> ReviewFeedback:
        """Parse agent output into ReviewFeedback using schema validation.

        Returns FAIL verdict when agent output does not conform to schema.
        """
        parsed, errors = validate_agent_output(raw, "review-output")

        if parsed is None:
            # Agent output was missing or invalid — treat as failure
            return ReviewFeedback(
                verdict=Verdict.FAIL,
                summary=f"Agent output validation failed: {'; '.join(errors)}",
            )

        verdict = Verdict.PASS if parsed["verdict"] == "pass" else Verdict.FAIL
        issues = [
            Issue(
                severity=Severity(i["severity"]),
                category=i["category"],
                description=i["description"],
                location=i.get("location", ""),
            )
            for i in parsed.get("issues", [])
        ]
        return ReviewFeedback(
            verdict=verdict,
            issues=issues,
            summary=parsed.get("summary", ""),
        )
