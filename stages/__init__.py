"""Stage registry with dynamic loading."""

from __future__ import annotations

from scripts.models import StageName
from stages.base import BaseStage
from stages.blackbox_test import BlackboxTestStage
from stages.bootstrap import BootstrapStage
from stages.finish import FinishStage
from stages.implement import ImplementStage
from stages.review import ReviewStage
from stages.whitebox_test import WhiteboxTestStage

# Registry mapping stage names to their implementations
_STAGE_REGISTRY: dict[StageName, type[BaseStage]] = {
    StageName.BOOTSTRAP: BootstrapStage,
    StageName.IMPLEMENT: ImplementStage,
    StageName.REVIEW: ReviewStage,
    StageName.WHITEBOX_TEST: WhiteboxTestStage,
    StageName.BLACKBOX_TEST: BlackboxTestStage,
    StageName.FINISH: FinishStage,
}


def get_stage(stage_name: StageName) -> BaseStage:
    """Instantiate a stage by name.

    Args:
        stage_name: The stage to instantiate.

    Returns:
        A new instance of the requested stage.

    Raises:
        KeyError: If the stage name is not registered.
    """
    stage_cls = _STAGE_REGISTRY.get(stage_name)
    if stage_cls is None:
        raise KeyError(f"No stage registered for: {stage_name}")
    return stage_cls()


def list_stages() -> list[tuple[str, str]]:
    """List all registered stages with their class names.

    Returns:
        List of (stage_name, class_name) tuples.
    """
    return [(s.value, cls.__name__) for s, cls in _STAGE_REGISTRY.items()]


def register_stage(stage_name: StageName, stage_cls: type[BaseStage]) -> None:
    """Register a custom stage implementation.

    Args:
        stage_name: The stage name to register.
        stage_cls: The stage class to use.
    """
    _STAGE_REGISTRY[stage_name] = stage_cls
