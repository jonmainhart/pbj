"""Authenticated commissioner HTTP API. S3 and processing stay server-side."""

import base64
import json
import os
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from aws import processing, storage
from aws.admin_csv import inspect_csv, published_csv
from pbj.week_data import load_games

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client


def condition(etag: str | None) -> Any:
    """Return conditional S3 request fields for existing or absent objects."""
    return {"IfMatch": etag} if etag else {"IfNoneMatch": "*"}


def response(status: int, body: Any) -> dict[str, Any]:
    return dict(
        statusCode=status,
        headers={"Content-Type": "application/json", "Cache-Control": "no-store"},
        body=json.dumps(body),
    )


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """Only API Gateway's verified access-token claims grant access."""
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    if (
        claims.get("token_use") != "access"
        or not claims.get("sub")
        or "pbj/admin" not in claims.get("scope", "").split()
        or claims.get("client_id") != os.environ.get("PBJ_ADMIN_CLIENT_ID")
    ):
        return response(403, {"message": "Commissioner authorization required"})
    try:
        return dispatch(event)
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        if code in ("PreconditionFailed", "ConditionalRequestConflict"):
            return response(
                409,
                {
                    "message": "Schedule state changed. Refresh the catalog before trying again."
                    if event.get("rawPath") == "/schedules/next"
                    else "Draft changed in another session. Reopen before saving."
                },
            )
        if code == "NoSuchKey":
            return response(404, {"message": "No schedule available for the selected week"})
        if event.get("rawPath") == "/announcements":
            return response(
                502, {"message": "Announcement request failed. Your edits are preserved."}
            )
        return response(502, {"message": "AWS operation failed; draft preserved. Retry safely."})
    except (ValueError, KeyError, TypeError) as exc:
        return response(400, {"message": str(exc)})
    except Exception:
        if event.get("rawPath") == "/announcements":
            return response(
                502, {"message": "Announcement request failed. Your edits are preserved."}
            )
        return response(502, {"message": "Operation failed; reopen the draft before retrying."})


def read_commissioner_object(
    s3: "S3Client", config: storage.StorageConfig, key: str
) -> storage.Snapshot | None:
    """Confirm absence on denied reads without hiding genuine permission errors."""
    try:
        return storage.read(s3, config, key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "AccessDenied":
            raise
        # Prefix-scoped ListBucket need not make missing GetObject return 404.
        # This bucket lists lexicographically: an exact key sorts before extensions.
        listing = s3.list_objects_v2(Bucket=config.bucket, Prefix=key, MaxKeys=1)
        if any(item.get("Key") == key for item in listing.get("Contents", [])):
            raise
        return None


def create_next(
    event: dict[str, Any], s3: "S3Client", config: storage.StorageConfig
) -> dict[str, Any]:
    body_text = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body_text = base64.b64decode(body_text).decode()
    body = json.loads(body_text)
    target = processing.next_creation(s3, config)
    if target is None or body.get("token") != target["token"]:
        return response(409, {"message": "Schedule state changed; refresh the schedule catalog"})
    if body.get("confirm") is not True:
        return response(422, {"message": "Confirm schedule creation or publication"})
    try:
        invoked = boto3.client(
            "lambda", config=Config(read_timeout=70, retries={"total_max_attempts": 1})
        ).invoke(
            FunctionName=os.environ["PBJ_PROCESSOR_FUNCTION"],
            InvocationType="RequestResponse",
            Payload=json.dumps(
                dict(
                    action="create_week",
                    season=target["season"],
                    week=target["week"],
                    publish_manifest=target["publish_manifest"],
                    creation_token=target["token"],
                )
            ).encode(),
        )
        with invoked["Payload"] as stream:
            result = json.loads(stream.read())
        if (
            not invoked.get("FunctionError")
            and result.get("status") == "ok"
            and result.get("season") == target["season"]
            and result.get("week") == target["week"]
        ):
            return response(
                200,
                {
                    "season": target["season"],
                    "week": target["week"],
                    "message": f"Week {target['week']} is published."
                    if target["publish_manifest"]
                    else "Schedule prepared privately. Public availability follows "
                    "scheduled publication.",
                },
            )
    except Exception:
        # Never retry an invocation whose result is uncertain.
        result = None
    catalog = processing.discover_schedules(s3, config)
    if (
        target["publish_manifest"]
        and catalog["season"] == target["season"]
        and catalog["week"] >= target["week"]
    ):
        return response(
            200,
            {
                "season": target["season"],
                "week": target["week"],
                "message": f"Week {target['week']} is published (confirmed after refresh).",
            },
        )
    exists = target["week"] in catalog["seasons"].get(str(target["season"]), [])
    return response(
        409 if exists else 502,
        {
            "message": "Schedule exists but is not published; refresh the catalog."
            if exists
            else "Operation was not confirmed. Refresh the catalog before trying again.",
        },
    )


def validate_announcements(value: Any) -> dict[str, Any]:
    """Validate the complete, deliberately small public document."""
    if not isinstance(value, dict) or set(value) != {"top", "bottom"}:
        raise ValueError("Provide top and bottom announcements")
    for item in value.values():
        if not isinstance(item, dict) or set(item) != {"text", "link"}:
            raise ValueError("Each announcement requires text and link")
        if not isinstance(item["text"], str) or len(item["text"]) > 2000:
            raise ValueError("Announcement text must be at most 2000 characters")
        link = item["link"]
        if link is None:
            continue
        if not isinstance(link, dict) or set(link) != {"label", "url"}:
            raise ValueError("Link requires label and URL")
        if not isinstance(link["label"], str) or not 1 <= len(link["label"].strip()) <= 120:
            raise ValueError("Link label must be 1-120 characters")
        url = link["url"]
        if not isinstance(url, str) or not 1 <= len(url) <= 2048:
            raise ValueError("Invalid link URL")
        parsed = urlsplit(url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or any(c.isspace() or ord(c) < 32 for c in url)
            or "\\" in url
        ):
            raise ValueError("Link must be an absolute HTTP or HTTPS URL")
        _ = parsed.port
    return value


def announcements(
    event: dict[str, Any], s3: "S3Client", config: storage.StorageConfig
) -> dict[str, Any]:
    method = event["requestContext"]["http"]["method"]
    key = "data/announcements.json"
    if method == "GET":
        snapshot = read_commissioner_object(s3, config, key)
        document = (
            validate_announcements(json.loads(snapshot.content))
            if snapshot
            else {position: {"text": "", "link": None} for position in ("top", "bottom")}
        )
        return response(200, {"document": document, "etag": snapshot.etag if snapshot else None})
    if method != "PUT":
        return response(405, {"message": "Method not allowed"})
    raw = event.get("body") or ""
    if len(raw) > 24000:
        return response(413, {"message": "Announcement request exceeds 16 KB"})
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw, validate=True).decode()
    if len(raw.encode()) > 16384:
        return response(413, {"message": "Announcement request exceeds 16 KB"})
    body = json.loads(raw)
    if not isinstance(body, dict) or set(body) != {"document", "etag"}:
        raise ValueError("Provide the complete document and last-read etag")
    etag = body["etag"]
    if etag is not None and (
        not isinstance(etag, str) or not etag or len(etag) > 128 or "*" in etag
    ):
        raise ValueError("Invalid announcement version")
    document = validate_announcements(body["document"])
    try:
        saved = s3.put_object(
            Bucket=config.bucket,
            Key=key,
            Body=json.dumps(document).encode(),
            ContentType="application/json",
            CacheControl="no-store",
            **condition(etag),
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("PreconditionFailed", "ConditionalRequestConflict"):
            return response(
                409,
                {
                    "message": (
                        "Announcements changed in another session. "
                        "Reload published content before publishing."
                    )
                },
            )
        raise
    return response(200, {"document": document, "etag": saved["ETag"]})


def dispatch(event: dict[str, Any]) -> dict[str, Any]:
    config = storage.StorageConfig.from_environment()
    s3 = storage.client()
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    if path == "/announcements":
        return announcements(event, s3, config)
    if method == "POST" and path == "/schedules/next":
        return create_next(event, s3, config)
    if method == "GET" and path == "/schedules":
        catalog = processing.discover_schedules(s3, config)
        return response(
            200,
            {**catalog, "user_id": event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]},
        )
    match = re.fullmatch(r"/weeks/(\d{4})/(0?[1-9]|1[0-8])(?:/(validate|draft|submit))?", path)
    if not match:
        return response(404, {"message": "Unknown endpoint"})
    season, week = int(match[1]), int(match[2])
    action = match[3]
    schedule = storage.read(s3, config, config.key(f"{season}/week{week:02d}.json"), required=True)
    if schedule is None:
        raise ValueError("Schedule unavailable")
    with TemporaryDirectory() as directory:
        local = Path(directory) / "week.json"
        local.write_bytes(schedule.content)
        games = load_games(local)
    if not games:
        return response(404, {"message": "Selected week has no schedule"})
    key = f"incoming/{season}/drafts/week{week:02d}.csv"
    published = bool(json.loads(schedule.content).get("players", []))
    if method == "GET" and action is None:
        draft = read_commissioner_object(s3, config, key)
        text = (
            draft.content.decode("utf-8-sig")
            if draft is not None
            else published_csv(json.loads(schedule.content).get("players", []), games)
        )
        return response(
            200,
            {
                **inspect_csv(text, games),
                "source": "draft" if draft is not None else "published" if published else "empty",
                "published": published,
                "etag": draft.etag if draft is not None else None,
                "games": [
                    dict(id=g.id, away=g.away.abbreviation, home=g.home.abbreviation) for g in games
                ],
            },
        )
    body_text = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body_text = base64.b64decode(body_text).decode()
    if len(body_text) > 500_000:
        return response(413, {"message": "CSV request exceeds 500 KB"})
    body = json.loads(body_text)
    etag = body.get("etag")
    if etag is not None and (not isinstance(etag, str) or not etag or "*" in etag):
        raise ValueError("Invalid draft version")
    if method == "DELETE" and action == "draft":
        if etag is None:
            raise ValueError("Draft version required for deletion")
        draft = read_commissioner_object(s3, config, key)
        if draft is None:
            return response(404, {"message": "No saved draft exists"})
        if draft.etag != etag:
            return response(
                409, {"message": "Draft changed in another session. Reopen before deleting."}
            )
        s3.delete_object(Bucket=config.bucket, Key=key, IfMatch=etag)
        return response(200, {"message": "Private draft deleted"})
    if (
        method == "POST"
        and action == "submit"
        and published
        and body.get("acknowledge_published") is not True
    ):
        return response(
            422, {"message": "Acknowledge that resubmission may alter published results"}
        )
    text = body.get("csv")
    if not isinstance(text, str):
        raise ValueError("csv must be a string")
    result = inspect_csv(text, games)
    if method == "POST" and action == "validate":
        return response(200, result)
    if (method, action) not in [("PUT", "draft"), ("POST", "submit")]:
        return response(405, {"message": "Method not allowed"})
    if action == "submit" and (
        body.get("confirm") is not True
        or not result["rows"]
        or any(i["severity"] == "error" for i in result["issues"])
    ):
        return response(422, {**result, "message": "Confirm submission and correct all errors"})
    # Drafts may contain errors: retain the exact editable CSV for correction.
    saved = s3.put_object(
        Bucket=config.bucket,
        Key=key,
        Body=text.encode(),
        ContentType="text/csv",
        **condition(etag),
    )
    result["etag"] = saved["ETag"]
    if action == "draft":
        return response(200, result)
    submitted_key = f"incoming/{season}/week{week:02d}.csv"
    previous = read_commissioner_object(s3, config, submitted_key)
    if previous and previous.content != result["csv"].encode():
        metadata = s3.head_object(Bucket=config.bucket, Key=submitted_key).get("Metadata", {})
        if metadata.get("state") != "complete":
            return response(
                409,
                {
                    **result,
                    "message": "Earlier submission unresolved. Retry its CSV or ask an operator.",
                },
            )
    # Conditional writes protect the private importer input; no public CSV copies.
    put = s3.put_object(
        Bucket=config.bucket,
        Key=submitted_key,
        Body=result["csv"].encode(),
        ContentType="text/csv",
        Metadata={"state": "pending"},
        **condition(previous.etag if previous else None),
    )
    invoked = boto3.client(
        "lambda", config=Config(read_timeout=70, retries={"total_max_attempts": 1})
    ).invoke(
        FunctionName=os.environ["PBJ_PROCESSOR_FUNCTION"],
        InvocationType="RequestResponse",
        Payload=json.dumps(dict(action="import_picks", season=season, week=week)).encode(),
    )
    payload = json.loads(invoked["Payload"].read())
    if invoked.get("FunctionError") or payload.get("status") != "ok":
        return response(
            502, {**result, "message": "Processor failed. Draft preserved; retry the same CSV."}
        )
    s3.put_object(
        Bucket=config.bucket,
        Key=submitted_key,
        Body=result["csv"].encode(),
        ContentType="text/csv",
        Metadata={"state": "complete"},
        IfMatch=put["ETag"],
    )
    return response(200, {**result, "result": payload, "message": "Picks submitted and processed"})
