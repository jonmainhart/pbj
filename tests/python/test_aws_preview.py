"""Preview deployment selection and origin boundaries, without AWS credentials."""

import re
from pathlib import Path

import pytest

from aws.deploy_site import upload_site
from scripts.build_site import build_site

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.smoke
def test_upload_only_public_static_files(tmp_path):
    artifact = tmp_path / "site"
    build_site(ROOT, artifact)
    (artifact / "private.csv").write_text("private")
    (artifact / "assets/private.csv").write_text("private")
    (artifact / "incoming").mkdir()
    (artifact / "incoming/private.json").write_text("{}")
    (artifact / "terraform").mkdir()
    (artifact / "terraform/private.json").write_text("{}")
    (artifact / "data/announcements.json").write_text("{}")
    (artifact / "assets/admin-config.json").write_text("{}")
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
        "assets/img/logo-transparent-full.webp",
        "assets/img/pbj-hero.webp",
        "assets/img/apple-touch-icon.png",
        "assets/img/logo-192x192.png",
        "assets/img/logo-512x512.png",
        "assets/img/favicon.png",
        "assets/documents/rules.html",
        "LEGAL.md",
    } <= keys
    assert not any(
        key.startswith(("data/", "incoming/", "terraform/")) or key.endswith(".csv") for key in keys
    )
    assert not {"CNAME", "BALLDONTLIE.key", "private.csv", "assets/admin-config.json"} & keys
    assert "admin/index.html" in keys
    assert all(bucket == "pbj-preview-jm26" for bucket, _, _ in calls)
    for _, key, args in calls:
        assert args["CacheControl"] == (
            "public, max-age=60, s-maxage=300" if key.startswith("assets/") else "no-cache"
        )
    headers = {key: args for _, key, args in calls}
    assert headers["index.html"]["ContentType"] == "text/html"
    assert headers["assets/documents/rules.html"]["ContentType"] == "text/html"
    for name in ("logo-transparent-full.webp", "pbj-hero.webp"):
        key = f"assets/img/{name}"
        assert headers[key]["ContentType"] == "image/webp"
        assert (artifact / key).read_bytes() == (ROOT / "site" / key).read_bytes()
        assert key.replace(".webp", ".png") not in keys
    for name in ("apple-touch-icon.png", "logo-192x192.png", "logo-512x512.png", "favicon.png"):
        assert headers[f"assets/img/{name}"]["ContentType"] == "image/png"
    assert headers["assets/app.js"]["ContentType"] in {"text/javascript", "application/javascript"}
    assert (artifact / "CNAME").exists()
    assert (artifact / "data/available-weeks.json").exists()


def test_origin_configuration_and_access_boundaries():
    config = " ".join((ROOT / "aws/terraform/preview.tf").read_text().split())
    default = config.split("default_cache_behavior {", 1)[1].split("ordered_cache_behavior", 1)[0]
    behaviors = config.split("ordered_cache_behavior {")[1:]
    assert len(behaviors) == 3
    data, admin_config, assets = behaviors
    disabled = 'cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"'
    assert disabled in default and disabled in data and disabled in admin_config
    assert 'path_pattern = "/assets/admin-config.json"' in admin_config
    assert 'target_origin_id = "static"' in admin_config
    assert 'path_pattern = "/assets/*"' in assets
    assert 'target_origin_id = "static"' in assets
    assert "cache_policy_id" not in assets
    assert "min_ttl = 0" in assets
    assert "default_ttl = 300" in assets and "max_ttl = 300" in assets
    assert "query_string = false" in assets and 'forward = "none"' in assets
    for behavior in (default, data, admin_config, assets):
        assert 'viewer_protocol_policy = "redirect-to-https"' in behavior
        assert 'allowed_methods = ["GET", "HEAD"]' in behavior
        assert 'cached_methods = ["GET", "HEAD"]' in behavior
        assert "compress = true" in behavior
    assert "response_headers_policy_id = aws_cloudfront_response_headers_policy.data.id" in data
    assert 'value = "no-store"' in config
    admin = (ROOT / "aws/terraform/admin.tf").read_text()
    assert 'cache_control = "no-store"' in admin
    assert 'target_origin_id = "static"' in default
    assert 'target_origin_id = "data"' in data
    assert 'path_pattern = "/data/*"' in data
    assert "${local.data_bucket}/data/*" in config
    assert "incoming/" not in config and "terraform/" not in config
    assert '"AWS:SourceArn"' in config
    assert "block_public_policy = true" in config
    assert "cloudfront_default_certificate = true" not in config
    assert 'aliases = ["www.pbjfootball.com", "pbjfootball.com"]' in config
    assert "acm_certificate_arn =" in config
    assert 'ssl_support_method = "sni-only"' in config
    assert 'minimum_protocol_version = "TLSv1.2_2021"' in config


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


def test_announcement_routes_and_object_scoped_write():
    config = (ROOT / "aws/terraform/admin.tf").read_text()
    for route in ["GET /announcements", "PUT /announcements"]:
        assert f'"{route}"' in config
    assert 'authorization_scopes = ["pbj/admin"]' in config
    assert (
        'Action = "s3:PutObject", Resource = '
        '"arn:aws:s3:::${local.data_bucket}/data/announcements.json"'
    ) in config
    assert (
        'Action = "s3:GetObject", Resource = "arn:aws:s3:::${local.data_bucket}/data/*"' in config
    )
    assert (
        'Action = "s3:ListBucket", Resource = "arn:aws:s3:::${local.data_bucket}", '
        'Condition = { StringLike = { "s3:prefix" = ["data/", "data/*"] } }'
    ) in config
    assert (
        'Action = "s3:ListBucket", Resource = "arn:aws:s3:::${local.data_bucket}" }' not in config
    )
