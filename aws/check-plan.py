"""Guard PBJ plans, allowing only exact tainted admin-config object recovery."""

import json
import sys

ALLOWED = {
    "aws_s3_bucket.preview",
    "aws_s3_bucket_public_access_block.preview",
    "aws_cloudfront_origin_access_control.preview",
    "aws_cloudfront_response_headers_policy.data",
    "aws_cloudfront_distribution.preview",
    "aws_s3_bucket_policy.preview",
    "aws_s3_bucket_policy.preview_data",
    "aws_iam_role.scheduler",
    "aws_iam_role_policy.scheduler",
    "aws_scheduler_schedule.create_week",
    "aws_scheduler_schedule.poll_games",
    "aws_iam_role.processor",
    "aws_iam_role_policy.processor",
    "aws_cloudwatch_log_group.processor",
    "aws_lambda_function.processor",
}
ALLOWED.update(
    {
        f"{kind}.admin"
        for kind in (
            "aws_cognito_user_pool",
            "aws_cognito_managed_login_branding",
            "aws_cognito_resource_server",
            "aws_cognito_user_pool_client",
            "aws_cognito_user_pool_domain",
            "aws_iam_role",
            "aws_iam_role_policy",
            "aws_cloudwatch_log_group",
            "aws_lambda_function",
            "aws_apigatewayv2_api",
            "aws_apigatewayv2_authorizer",
            "aws_apigatewayv2_integration",
            "aws_apigatewayv2_stage",
            "aws_lambda_permission",
            "aws_cloudfront_function",
        )
    }
)
ALLOWED.add("aws_s3_object.admin_config")
ALLOWED.update(
    f'aws_apigatewayv2_route.admin["{route}"]'
    for route in (
        "GET /schedules",
        "GET /weeks/{season}/{week}",
        "POST /weeks/{season}/{week}/validate",
        "PUT /weeks/{season}/{week}/draft",
        "POST /weeks/{season}/{week}/submit",
    )
)
plan = json.load(sys.stdin)
if plan.get("errored") or plan.get("complete") is False:
    sys.exit("Incomplete or errored plan")
for change in plan.get("resource_changes", []):
    if change["mode"] == "data":
        continue
    actions = change["change"]["actions"]
    details = change["change"]
    unknown = details.get("after_unknown")
    tainted_admin_config = (
        change["address"] == "aws_s3_object.admin_config"
        and change["mode"] == "managed"
        and actions == ["delete", "create"]
        and change.get("action_reason") == "replace_because_tainted"
        and all(
            isinstance(details.get(side), dict)
            and details[side].get("bucket") == "pbj-preview-jm26"
            and details[side].get("key") == "assets/admin-config.json"
            for side in ("before", "after")
        )
        and isinstance(unknown, dict)
        and all(unknown.get(field, False) is False for field in ("bucket", "key"))
    )
    if change["address"] not in ALLOWED or (
        actions not in (["no-op"], ["create"], ["update"]) and not tainted_admin_config
    ):
        sys.exit(f"Rejected {change['address']}: {actions}")
print(
    "Plan accepted: allowlisted no-ops, creates, in-place updates, and verified "
    "tainted admin configuration object replacement only"
)
