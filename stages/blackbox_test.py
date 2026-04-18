"""Blackbox-Test stage: user-perspective testing without source code access."""

from __future__ import annotations

from pathlib import Path

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


class BlackboxTestStage(BaseStage):
    """Black-box testing: agent tests from user perspective, NO source code access."""

    @property
    def name(self) -> StageName:
        return StageName.BLACKBOX_TEST

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
            stage_specific_context={
                "exclude_source_code": "true",
            },
        )

        # Load spec user scenarios only — NO source code
        if context.spec_path.exists():
            ctx.spec_content = context.spec_path.read_text(encoding="utf-8")

        return ctx

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        prompt = self._build_test_prompt(context)

        try:
            result = self._invoke_agent(prompt, context, config)
        except Exception as e:
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message=str(e),
            )

        feedback = self._parse_test_result(result)

        test_path = get_run_state_dir(context.project_path, context.run_id) / "test-result.json"
        test_path.parent.mkdir(parents=True, exist_ok=True)
        test_path.write_text(feedback.model_dump_json(indent=2), encoding="utf-8")

        return StageOutput(
            stage_name=self.name,
            verdict=feedback.verdict,
            result_path=test_path,
            artifacts={"test-result": test_path},
        )

    def determine_next_stage(self, output: StageOutput) -> StageName | None:
        if output.verdict == Verdict.PASS:
            return StageName.FINISH
        return StageName.IMPLEMENT

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        test_path = output.result_path if output.result_path else None
        if test_path is None or not test_path.exists():
            return ValidationResult(is_valid=False, errors=["test-result.json not found"])

        try:
            import json
            content = json.loads(test_path.read_text(encoding="utf-8"))
            parsed, parse_errors = validate_agent_output(content, "review-output")
            if parsed is None:
                errors.extend(f"test-result.json: {e}" for e in parse_errors)
        except (json.JSONDecodeError, ValueError) as e:
            errors.append(f"test-result.json is not valid JSON: {e}")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def _build_test_prompt(self, context: StageContext) -> str:
        """Build blackbox test prompt using template."""
        from context.builder import load_project_context, render_template

        spec_text = ""
        if context.spec_path.exists():
            spec_text = context.spec_path.read_text(encoding="utf-8")

        # Derive app access info from worktree
        app_access = self._get_app_access_info(context.worktree_path)

        project_ctx = load_project_context(context.worktree_path)

        return render_template(self.name, {
            **project_ctx,
            "spec_content": spec_text,
            "app_access_info": app_access,
            "feedback": "",
        })

    def _get_app_access_info(self, worktree_path: Path) -> str:
        """Derive how to access the application for testing."""
        lines = []
        if (worktree_path / "package.json").exists():
            lines.append("Node.js 项目，检查 package.json 中的 scripts 了解启动方式。")
        if (worktree_path / "pyproject.toml").exists():
            lines.append("Python 项目，检查 pyproject.toml 中的入口点。")
        if (worktree_path / "Makefile").exists():
            lines.append("存在 Makefile，可尝试 `make run` 或 `make test`。")
        if not lines:
            lines.append("请根据项目结构自行确定应用启动和访问方式。")
        return "\n".join(lines)

    def _invoke_agent(self, prompt: str, context: StageContext, config: StageConfig) -> dict:
        from agents.claude import ClaudeBackend
        backend = ClaudeBackend()
        schema_path = get_schema_path("review-output")
        result = backend.invoke(
            prompt=prompt,
            working_dir=context.worktree_path,
            timeout=config.timeout_seconds,
            max_turns=config.max_turns,
            max_budget_usd=config.max_budget_usd,
            output_schema=schema_path,
        )
        if result.timed_out:
            raise TimeoutError("Blackbox test agent timed out")
        return result.parsed_output or {}

    def _parse_test_result(self, raw: dict) -> ReviewFeedback:
        """Parse agent output into ReviewFeedback using schema validation.

        Returns FAIL verdict when agent output does not conform to schema.
        """
        parsed, errors = validate_agent_output(raw, "review-output")

        if parsed is None:
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
                suggested_fix=i.get("suggested_fix", ""),
            )
            for i in parsed.get("issues", [])
        ]
        return ReviewFeedback(verdict=verdict, issues=issues, summary=parsed.get("summary", ""))
