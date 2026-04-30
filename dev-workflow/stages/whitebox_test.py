"""Whitebox-Test stage: write and execute tests against implementation code."""

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
from stages.base import BaseStage, format_agent_failure

logger = logging.getLogger(__name__)


class WhiteboxTestStage(BaseStage):
    """White-box testing: agent writes and executes tests with access to source code."""

    @property
    def name(self) -> StageName:
        return StageName.WHITEBOX_TEST

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

        if context.spec_path.exists():
            ctx.spec_content = context.spec_path.read_text(encoding="utf-8")

        return ctx

    def execute(self, context: StageContext, config: StageConfig) -> StageOutput:
        prompt = self._build_test_prompt(context)
        logger.info("Whitebox test prompt built: %d chars", len(prompt))

        try:
            result = self._invoke_agent(prompt, context, config)
        except Exception as e:
            logger.error("Whitebox test agent FAILED: %s", e)
            return StageOutput(
                stage_name=self.name,
                verdict=Verdict.FAIL,
                error_message=str(e),
            )

        feedback = self._parse_test_result(result)
        logger.info("Whitebox test verdict: %s, issues: %d", feedback.verdict.value, len(feedback.issues))

        test_path = get_run_state_dir(context.project_path, context.run_id) / "test-result.json"
        test_path.parent.mkdir(parents=True, exist_ok=True)
        test_path.write_text(feedback.model_dump_json(indent=2), encoding="utf-8")

        return StageOutput(
            stage_name=self.name,
            verdict=feedback.verdict,
            result_path=test_path,
            artifacts={"test-result": test_path},
        )

    def validate_output(self, output: StageOutput, worktree_path: Path) -> ValidationResult:
        errors = []
        test_path = output.result_path if output.result_path else None
        if test_path is None or not test_path.exists():
            return ValidationResult(is_valid=False, errors=["test-result.json not found"])

        try:
            ReviewFeedback.model_validate_json(test_path.read_text(encoding="utf-8"))
        except Exception as e:
            errors.append(f"test-result.json is not valid JSON: {e}")

        return ValidationResult(is_valid=len(errors) == 0, errors=errors)

    def _build_test_prompt(self, context: StageContext) -> str:
        """Build whitebox test prompt using template."""
        from context.builder import load_project_context, render_template

        agent_ctx = context.agent_context or self.build_agent_context(context)
        spec_text = agent_ctx.spec_content

        # Collect source file references
        file_refs = self._collect_source_files(context.worktree_path)

        # Detect existing test patterns
        test_patterns = self._detect_test_patterns(context.worktree_path)

        project_ctx = load_project_context(context.worktree_path)

        return render_template(self.name, {
            **project_ctx,
            "spec_content": spec_text,
            "file_refs": file_refs,
            "test_patterns": test_patterns,
            "feedback": "",
        })

    def _collect_source_files(self, worktree_path: Path) -> str:
        """List source files in the worktree for agent reference.

        Uses ``git ls-files`` so the result is language-agnostic and
        automatically respects .gitignore rules.
        """
        import subprocess

        try:
            result = subprocess.run(
                ["git", "ls-files"],
                cwd=str(worktree_path),
                capture_output=True,
                text=True,
            )
            if result.returncode == 0 and result.stdout.strip():
                return "\n".join(f"- `{line}`" for line in result.stdout.splitlines())
        except Exception:
            pass
        return "请自行查找源文件。"

    def _detect_test_patterns(self, worktree_path: Path) -> str:
        """Detect test framework and patterns from existing test files."""
        indicators = {
            "pytest": worktree_path / "pytest.ini",
            "unittest": worktree_path / "setup.py",
            "jest": worktree_path / "jest.config.js",
            "vitest": worktree_path / "vitest.config.ts",
        }
        detected = [name for name, path in indicators.items() if path.exists()]
        if detected:
            return f"检测到测试框架: {', '.join(detected)}"
        return "未检测到测试框架，请使用项目标准测试工具。"

    def _invoke_agent(self, prompt: str, context: StageContext, config: StageConfig) -> dict:
        backend = get_agent_backend(config.agent_backend)
        schema_path = get_schema_path("review-output")

        state_dir = get_run_state_dir(context.project_path, context.run_id)
        debug_log_dir = state_dir / "agent-logs" / f"whitebox-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
        logger.info("Whitebox test agent debug log dir: %s", debug_log_dir)

        result = backend.invoke(
            prompt=prompt,
            working_dir=context.worktree_path,
            timeout=config.timeout_seconds,
            model=config.agent_model,
            output_schema=schema_path,
            debug_log_dir=debug_log_dir,
        )

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
            raise TimeoutError(format_agent_failure(
                stage_label="Whitebox test",
                agent_backend=config.agent_backend,
                agent_model=config.agent_model,
                timeout_seconds=config.timeout_seconds,
                debug_log_dir=debug_log_dir,
                reason="agent timed out",
            ))
        if result.exit_code != 0:
            raise RuntimeError(format_agent_failure(
                stage_label="Whitebox test",
                agent_backend=config.agent_backend,
                agent_model=config.agent_model,
                timeout_seconds=config.timeout_seconds,
                debug_log_dir=debug_log_dir,
                exit_code=result.exit_code,
                reason=result.stderr or "agent returned non-zero exit status",
            ))
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
            )
            for i in parsed.get("issues", [])
        ]
        return ReviewFeedback(verdict=verdict, issues=issues, summary=parsed.get("summary", ""))
