"""Deployment plans must not delete resources or expand managed scope."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

GUARD = Path(__file__).resolve().parents[2] / "aws" / "check-plan.py"
SCHEDULER_INPUT = '{"action":"create_week","scheduled_time":"<aws.scheduler.scheduled-time>"}'


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
        *[
            (address, actions, accepted)
            for address in (
                "aws_s3_bucket.preview",
                "aws_s3_bucket_public_access_block.preview",
                "aws_cloudfront_origin_access_control.preview",
                "aws_cloudfront_response_headers_policy.data",
                "aws_cloudfront_distribution.preview",
                "aws_s3_bucket_policy.preview",
                "aws_s3_bucket_policy.preview_data",
            )
            for actions, accepted in (
                (["create"], True),
                (["update"], True),
                (["delete"], False),
                (["delete", "create"], False),
            )
        ],
        *[
            ("aws_s3_object.admin_config", actions, accepted)
            for actions, accepted in (
                (["create"], True),
                (["update"], True),
                (["no-op"], True),
                (["delete"], False),
                (["delete", "create"], False),
                (["create", "delete"], False),
            )
        ],
        *[
            (
                'aws_apigatewayv2_route.admin["DELETE /weeks/{season}/{week}/draft"]',
                actions,
                accepted,
            )
            for actions, accepted in (
                (["create"], True),
                (["update"], True),
                (["delete"], False),
                (["delete", "create"], False),
            )
        ],
        ('aws_apigatewayv2_route.admin["POST /schedules/next"]', ["create"], True),
        ('aws_apigatewayv2_route.admin["GET /announcements"]', ["create"], True),
        ('aws_apigatewayv2_route.admin["PUT /announcements"]', ["create"], True),
        ('aws_apigatewayv2_route.admin["DELETE /weeks/{season}/{week}"]', ["create"], False),
        ("aws_s3_object.picks", ["create"], False),
        ("aws_cloudfront_cache_policy.assets", ["create"], False),
        ("aws_cloudfront_distribution.other", ["update"], False),
        ("aws_iam_role.power_user", ["update"], False),
        ("aws_iam_role_policy.processor", ["delete"], False),
    ],
)
def test_plan_guard(address: str, actions: list[str], accepted: bool) -> None:
    plan: dict[str, Any] = {
        "resource_changes": [
            {"address": address, "mode": "managed", "change": {"actions": actions}}
        ]
    }
    if address == "aws_scheduler_schedule.create_week":
        plan["resource_changes"][0]["change"]["after"] = {"target": [{"input": SCHEDULER_INPUT}]}
    result = subprocess.run(  # noqa: S603 - fixed interpreter and repository script
        [sys.executable, str(GUARD)], input=json.dumps(plan), text=True, capture_output=True
    )
    assert (result.returncode == 0) is accepted, result.stderr


@pytest.mark.parametrize("actions", [["create"], ["update"], ["no-op"]])
@pytest.mark.parametrize(
    ("scheduler_input", "accepted"),
    [
        (SCHEDULER_INPUT, True),
        (f"\n  {SCHEDULER_INPUT}\n", True),
        (SCHEDULER_INPUT.replace("<", r"\u003c").replace(">", r"\u003e"), False),
        (SCHEDULER_INPUT.replace("<", r"\u003c"), False),
        (SCHEDULER_INPUT.replace(">", r"\u003e"), False),
        (SCHEDULER_INPUT.replace("create_week", "poll_games"), False),
        (SCHEDULER_INPUT.replace("scheduled_time", "other"), False),
        (SCHEDULER_INPUT[:-1], False),
        ("{}", False),
        (None, False),
    ],
)
def test_scheduler_input_guard(actions, scheduler_input, accepted):
    plan = {
        "resource_changes": [
            {
                "address": "aws_scheduler_schedule.create_week",
                "mode": "managed",
                "change": {
                    "actions": actions,
                    "after": {"target": [{"input": scheduler_input}]},
                },
            }
        ]
    }
    result = subprocess.run(  # noqa: S603 - fixed interpreter and repository script
        [sys.executable, str(GUARD)], input=json.dumps(plan), text=True, capture_output=True
    )
    assert (result.returncode == 0) is accepted, result.stderr


@pytest.mark.parametrize(
    ("path", "value", "accepted"),
    [
        ((), None, True),
        (("address",), "aws_lambda_function.processor", False),
        (("address",), "aws_s3_object.other", False),
        (("mode",), "__missing__", False),
        (("action_reason",), "replace_because_cannot_update", False),
        (("action_reason",), "replace_by_request", False),
        (("action_reason",), "__missing__", False),
        (("action_reason",), None, False),
        (("change", "actions"), ["create", "delete"], False),
        (("change", "actions"), ["delete"], False),
        (("change", "actions"), ["delete", "create", "read"], False),
        *[
            (("change", side, field), value, False)
            for side in ("before", "after")
            for field, value in (
                ("bucket", "other-bucket"),
                ("key", "assets/other.json"),
                ("bucket", None),
                ("key", None),
                ("bucket", "__missing__"),
                ("key", "__missing__"),
            )
        ],
        *[
            (("change", field), value, False)
            for field in ("before", "after", "after_unknown")
            for value in (None, True, "__missing__")
        ],
        (("change", "after_unknown", "bucket"), True, False),
        (("change", "after_unknown", "key"), True, False),
        (("change", "after_unknown", "key"), {}, False),
        (("change", "after_unknown"), {"bucket": False, "key": False}, True),
    ],
)
def test_tainted_admin_config_replacement(path, value, accepted):
    change: dict[str, Any] = {
        "address": "aws_s3_object.admin_config",
        "mode": "managed",
        "action_reason": "replace_because_tainted",
        "change": {
            "actions": ["delete", "create"],
            "before": {"bucket": "pbj-preview-jm26", "key": "assets/admin-config.json"},
            "after": {"bucket": "pbj-preview-jm26", "key": "assets/admin-config.json"},
            "after_unknown": {},
        },
    }
    if path:
        parent = change
        for field in path[:-1]:
            parent = parent[field]
        if value == "__missing__":
            del parent[path[-1]]
        else:
            parent[path[-1]] = value
    result = subprocess.run(  # noqa: S603 - fixed interpreter and repository script
        [sys.executable, str(GUARD)],
        input=json.dumps({"resource_changes": [change]}),
        text=True,
        capture_output=True,
    )
    assert (result.returncode == 0) is accepted, result.stderr
    if accepted:
        assert "tainted admin configuration object replacement" in result.stdout


def test_admin_config_delete_permission_is_object_scoped():
    policy = json.loads((GUARD.parent / "iam/terraform-user.json").read_text())
    matching = [
        statement
        for statement in policy["Statement"]
        if statement["Resource"] == "arn:aws:s3:::pbj-preview-jm26/assets/admin-config.json"
    ]
    assert len(matching) == 1
    assert set(matching[0]["Action"]) == {
        "s3:GetObject",
        "s3:PutObject",
        "s3:GetObjectTagging",
        "s3:DeleteObject",
    }
    for statement in policy["Statement"]:
        if "s3:DeleteObject" in statement["Action"]:
            assert statement["Resource"] in {
                "arn:aws:s3:::pbj-preview-jm26/assets/admin-config.json",
                "arn:aws:s3:::pbj-data-jm26/terraform/pbj.tfstate.tflock",
            }
