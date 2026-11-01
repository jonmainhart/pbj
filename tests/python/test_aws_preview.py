"""Preview deployment selection and origin boundaries, without AWS credentials."""

import re
from pathlib import Path

from aws.deploy_site import upload_site
from scripts.build_site import build_site

ROOT = Path(__file__).resolve().parents[2]


def test_upload_only_public_static_files(tmp_path):
    artifact = tmp_path / "site"
    build_site(ROOT, artifact)
    (artifact / "private.csv").write_text("private")
    (artifact / "BALLDONTLIE.key").write_text("secret")
    calls = []

    class S3:
        def upload_file(self, filename, bucket, key, ExtraArgs):
            calls.append((bucket, key, ExtraArgs))

    upload_site(S3(), artifact)
    keys = {key for _, key, _ in calls}
    assert {
        "index.html",
        "manifest.webmanifest",
        "assets/app.js",
        "assets/announcement-top.txt",
        "assets/announcement-bottom.txt",
        "assets/documents/rules.html",
        "LEGAL.md",
    } <= keys
    assert not any(key.startswith("data/") or key.endswith(".csv") for key in keys)
    assert not {"CNAME", "BALLDONTLIE.key", "private.csv"} & keys
    assert all(bucket == "pbj-preview-jm26" for bucket, _, _ in calls)
    assert all(args["CacheControl"] == "no-cache" for _, _, args in calls)
    assert (artifact / "CNAME").exists()
    assert (artifact / "data/available-weeks.json").exists()


def test_origin_configuration_and_access_boundaries():
    config = " ".join((ROOT / "aws/terraform/preview.tf").read_text().split())
    default = config.split("default_cache_behavior {", 1)[1].split("ordered_cache_behavior", 1)[0]
    data = config.split("ordered_cache_behavior {", 1)[1].split("restrictions", 1)[0]
    assert 'target_origin_id = "static"' in default
    assert 'target_origin_id = "data"' in data
    assert 'path_pattern = "/data/*"' in data
    assert "${local.data_bucket}/data/*" in config
    assert "incoming/" not in config and "terraform/" not in config
    assert '"AWS:SourceArn"' in config
    assert "block_public_policy = true" in config
    assert "cloudfront_default_certificate = true" in config


def test_operational_policy_is_owned_directly_and_scoped_to_preview():
    config = " ".join((ROOT / "aws/terraform/preview.tf").read_text().split())
    policy = config.split('resource "aws_s3_bucket_policy" "preview_data" {', 1)[1]
    policy = policy.split('output "preview_hostname"', 1)[0]
    assert "bucket = local.data_bucket" in policy
    assert "policy = jsonencode({" in policy
    assert policy.count("Sid =") == 1
    assert 'Sid = "PBJPreviewDataRead"' in policy
    assert 'Effect = "Allow"' in policy
    assert 'Principal = { Service = "cloudfront.amazonaws.com" }' in policy
    assert 'Action = "s3:GetObject"' in policy
    assert 'Resource = "arn:aws:s3:::${local.data_bucket}/data/*"' in policy
    assert (
        'Condition = { StringEquals = { "AWS:SourceArn" = '
        "aws_cloudfront_distribution.preview.arn } }" in policy
    )
    assert "lifecycle { prevent_destroy = true }" in policy
    assert "variable " not in config and 'data "aws_iam_policy_document"' not in config
    resources = set(re.findall(r'resource "([^" ]+)" "([^" ]+)"', config))
    assert resources == {
        ("aws_s3_bucket", "preview"),
        ("aws_s3_bucket_public_access_block", "preview"),
        ("aws_cloudfront_origin_access_control", "preview"),
        ("aws_cloudfront_response_headers_policy", "data"),
        ("aws_cloudfront_distribution", "preview"),
        ("aws_s3_bucket_policy", "preview"),
        ("aws_s3_bucket_policy", "preview_data"),
    }
