"""Regression tests for orchestrator transition handling."""

from __future__ import annotations

import pytest

from scripts.config import WorkflowConfig
from scripts.engine import WorkflowEngine
from scripts.models import StageExecution, StageName, StageOutput, StageStatus, Verdict, WorkflowInstance
from scripts.orchestrator import (
    _is_review_backed_implement,
    _should_force_review_pass_after_loop_limit,
    _should_skip_review_after_review_fix,
    _trigger_transition,
)


class TestOrchestratorTransitions:
    @staticmethod
    def _make_engine(stage: StageName) -> tuple[WorkflowInstance, WorkflowEngine]:
        instance = WorkflowInstance(slug="demo", current_stage=stage)
        engine = WorkflowEngine(instance)
        engine.start()
        return instance, engine

    def test_implement_self_transition_reports_success(self):
        instance, engine = self._make_engine(StageName.IMPLEMENT)
        engine.set_tasks_complete(False)

        transitioned = _trigger_transition(engine, StageName.IMPLEMENT, Verdict.PASS)

        assert transitioned is True
        assert instance.current_stage == StageName.IMPLEMENT

    def test_implement_can_skip_followup_review_when_loop_policy_requests_it(self):
        instance, engine = self._make_engine(StageName.IMPLEMENT)
        engine.set_tasks_complete(True)
        engine.set_skip_review_after_implement(True)

        transitioned = _trigger_transition(engine, StageName.IMPLEMENT, Verdict.PASS)

        assert transitioned is True
        assert instance.current_stage == StageName.WHITEBOX_TEST

    def test_implement_fail_transitions_to_failed(self):
        instance, engine = self._make_engine(StageName.IMPLEMENT)

        transitioned = _trigger_transition(engine, StageName.IMPLEMENT, Verdict.FAIL)

        assert transitioned is True
        assert instance.status.value == "failed"

    def test_adjudicate_without_target_reports_no_transition(self):
        instance, engine = self._make_engine(StageName.ADJUDICATE)

        transitioned = _trigger_transition(engine, StageName.ADJUDICATE, Verdict.PASS)

        assert transitioned is False
        assert instance.current_stage == StageName.ADJUDICATE

    def test_adjudicate_fail_transitions_to_failed(self):
        instance, engine = self._make_engine(StageName.ADJUDICATE)

        transitioned = _trigger_transition(engine, StageName.ADJUDICATE, Verdict.FAIL)

        assert transitioned is True
        assert instance.status.value == "failed"

    def test_finish_fail_transitions_to_failed(self):
        instance, engine = self._make_engine(StageName.FINISH)

        transitioned = _trigger_transition(engine, StageName.FINISH, Verdict.FAIL)

        assert transitioned is True
        assert instance.status.value == "failed"

    @pytest.mark.parametrize(
        "stage, verdict, setup, expected_stage, expected_status",
        [
            (
                StageName.BOOTSTRAP,
                Verdict.PASS,
                lambda engine: engine.set_verdict(Verdict.PASS),
                StageName.IMPLEMENT,
                "pending",
            ),
            (
                StageName.BOOTSTRAP,
                Verdict.FAIL,
                lambda engine: engine.set_verdict(Verdict.FAIL),
                StageName.BOOTSTRAP,
                "failed",
            ),
            (
                StageName.IMPLEMENT,
                Verdict.PASS,
                lambda engine: engine.set_tasks_complete(False),
                StageName.IMPLEMENT,
                "pending",
            ),
            (
                StageName.IMPLEMENT,
                Verdict.PASS,
                lambda engine: engine.set_tasks_complete(True),
                StageName.REVIEW,
                "pending",
            ),
            (
                StageName.IMPLEMENT,
                Verdict.FAIL,
                lambda engine: None,
                StageName.IMPLEMENT,
                "failed",
            ),
            (
                StageName.REVIEW,
                Verdict.PASS,
                lambda engine: engine.set_verdict(Verdict.PASS),
                StageName.WHITEBOX_TEST,
                "pending",
            ),
            (
                StageName.REVIEW,
                Verdict.FAIL,
                lambda engine: engine.set_verdict(Verdict.FAIL),
                StageName.ADJUDICATE,
                "pending",
            ),
            (
                StageName.WHITEBOX_TEST,
                Verdict.PASS,
                lambda engine: engine.set_verdict(Verdict.PASS),
                StageName.BLACKBOX_TEST,
                "pending",
            ),
            (
                StageName.WHITEBOX_TEST,
                Verdict.FAIL,
                lambda engine: engine.set_verdict(Verdict.FAIL),
                StageName.ADJUDICATE,
                "pending",
            ),
            (
                StageName.BLACKBOX_TEST,
                Verdict.PASS,
                lambda engine: engine.set_verdict(Verdict.PASS),
                StageName.FINISH,
                "pending",
            ),
            (
                StageName.BLACKBOX_TEST,
                Verdict.FAIL,
                lambda engine: engine.set_verdict(Verdict.FAIL),
                StageName.ADJUDICATE,
                "pending",
            ),
            (
                StageName.FINISH,
                Verdict.PASS,
                lambda engine: engine.set_verdict(Verdict.PASS),
                StageName.FINISH,
                "completed",
            ),
            (
                StageName.FINISH,
                Verdict.FAIL,
                lambda engine: engine.set_verdict(Verdict.FAIL),
                StageName.FINISH,
                "failed",
            ),
        ],
    )
    def test_agent_return_states_can_drive_transitions(
        self,
        stage: StageName,
        verdict: Verdict,
        setup,
        expected_stage: StageName,
        expected_status: str,
    ):
        instance, engine = self._make_engine(stage)

        setup(engine)

        transitioned = _trigger_transition(engine, stage, verdict)

        assert transitioned is True
        assert instance.current_stage == expected_stage
        assert instance.status.value == expected_status

    @pytest.mark.parametrize(
        "target, expected_stage",
        [
            (StageName.IMPLEMENT, StageName.IMPLEMENT),
            (StageName.WHITEBOX_TEST, StageName.WHITEBOX_TEST),
            (StageName.BLACKBOX_TEST, StageName.BLACKBOX_TEST),
            (StageName.FINISH, StageName.FINISH),
        ],
    )
    def test_adjudicate_target_routes_to_expected_stage(self, target: StageName, expected_stage: StageName):
        instance, engine = self._make_engine(StageName.ADJUDICATE)
        engine.set_verdict(Verdict.PASS)
        engine.set_adjudicate_target(target)

        transitioned = _trigger_transition(engine, StageName.ADJUDICATE, Verdict.PASS)

        assert transitioned is True
        assert instance.current_stage == expected_stage


class TestReviewLoopPolicy:
    @staticmethod
    def _instance_with_review_failures(count: int) -> WorkflowInstance:
        return WorkflowInstance(
            slug="demo",
            stage_executions=[
                StageExecution(
                    stage_name=StageName.REVIEW,
                    status=StageStatus.FAILED,
                )
                for _ in range(count)
            ],
        )

    def test_review_backed_implement_detection_uses_output_source_stage(self):
        output = StageOutput(
            stage_name=StageName.IMPLEMENT,
            verdict=Verdict.PASS,
            output_data={"source_stage": "review"},
        )

        assert _is_review_backed_implement(output) is True

    def test_disabled_followup_review_loops_skip_after_first_review_fix(self):
        config = WorkflowConfig.model_validate({
            "workflow": {
                "enable_followup_review_loops": False,
                "max_review_loops": 3,
            },
        })
        instance = self._instance_with_review_failures(1)

        assert _should_skip_review_after_review_fix(instance, config) is True
        assert _should_force_review_pass_after_loop_limit(instance, config) is False

    def test_review_loop_limit_skips_review_after_configured_fix_count(self):
        config = WorkflowConfig.model_validate({
            "workflow": {
                "enable_followup_review_loops": True,
                "max_review_loops": 3,
            },
        })

        assert _should_skip_review_after_review_fix(
            self._instance_with_review_failures(2),
            config,
        ) is False
        assert _should_skip_review_after_review_fix(
            self._instance_with_review_failures(3),
            config,
        ) is True

    def test_review_loop_limit_forces_pass_only_after_exceeding_limit(self):
        config = WorkflowConfig.model_validate({
            "workflow": {
                "enable_followup_review_loops": True,
                "max_review_loops": 3,
            },
        })

        assert _should_force_review_pass_after_loop_limit(
            self._instance_with_review_failures(3),
            config,
        ) is False
        assert _should_force_review_pass_after_loop_limit(
            self._instance_with_review_failures(4),
            config,
        ) is True
