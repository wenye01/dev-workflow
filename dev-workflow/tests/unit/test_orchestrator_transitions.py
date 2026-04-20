"""Regression tests for orchestrator transition handling."""

from __future__ import annotations

import pytest

from scripts.engine import WorkflowEngine
from scripts.models import StageName, Verdict, WorkflowInstance
from scripts.orchestrator import _trigger_transition


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
