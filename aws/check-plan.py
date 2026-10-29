"""Fail closed on deletion, replacement, or resources outside the PBJ allowlist."""

import json
import sys

ALLOWED = {
    "aws_iam_role.scheduler",
    "aws_iam_role_policy.scheduler",
    "aws_scheduler_schedule.create_week",
    "aws_scheduler_schedule.poll_games",
    "aws_iam_role.processor",
    "aws_iam_role_policy.processor",
    "aws_cloudwatch_log_group.processor",
    "aws_lambda_function.processor",
}
plan = json.load(sys.stdin)
if plan.get("errored") or plan.get("complete") is False:
    sys.exit("Incomplete or errored plan")
for change in plan.get("resource_changes", []):
    if change["mode"] == "data":
        continue
    actions = change["change"]["actions"]
    if change["address"] not in ALLOWED or actions not in (["no-op"], ["create"], ["update"]):
        sys.exit(f"Rejected {change['address']}: {actions}")
print("Plan accepted: only allowed creates and in-place updates")
