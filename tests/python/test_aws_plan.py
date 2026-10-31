"""Deployment plans must not delete resources or expand managed scope."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

GUARD = Path(__file__).resolve().parents[2] / "aws" / "check-plan.py"


@pytest.mark.parametrize(
    ("address", "actions", "accepted"),
    [
        ("aws_scheduler_schedule.create_week", ["create"], True),
        ("aws_scheduler_schedule.poll_games", ["update"], True),
        ("aws_iam_role.scheduler", ["create"], True),
        ("aws_iam_role_policy.scheduler", ["create"], True),
        ("aws_scheduler_schedule.poll_games", ["delete"], False),
        ("aws_scheduler_schedule.other", ["create"], False),
        ("aws_lambda_function.processor", ["create"], True),
        ("aws_lambda_function.processor", ["update"], True),
        ("aws_lambda_function.processor", ["no-op"], True),
        ("aws_lambda_function.processor", ["delete"], False),
        ("aws_lambda_function.processor", ["delete", "create"], False),
        ("aws_lambda_function.processor", ["create", "delete"], False),
        ("aws_s3_object.picks", ["create"], False),
        ("aws_iam_role.power_user", ["update"], False),
        ("aws_iam_role_policy.processor", ["delete"], False),
    ],
)
def test_plan_guard(address: str, actions: list[str], accepted: bool) -> None:
    plan = {
        "resource_changes": [
            {"address": address, "mode": "managed", "change": {"actions": actions}}
        ]
    }
    result = subprocess.run(  # noqa: S603 - fixed interpreter and repository script
        [sys.executable, str(GUARD)], input=json.dumps(plan), text=True, capture_output=True
    )
    assert (result.returncode == 0) is accepted, result.stderr
