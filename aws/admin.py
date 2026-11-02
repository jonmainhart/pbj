"""Authenticated commissioner HTTP API. S3 and processing stay server-side."""

import base64
import json
import os
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING, Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from aws import storage
from aws.admin_csv import inspect_csv, published_csv
from pbj.active_week import select_active_week
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
                409, {"message": "Draft changed in another session. Reopen before saving."}
            )
        if code == "NoSuchKey":
            return response(404, {"message": "No schedule available for the selected week"})
        return response(502, {"message": "AWS operation failed; draft preserved. Retry safely."})
    except (ValueError, KeyError, TypeError) as exc:
        return response(400, {"message": str(exc)})
    except Exception:
        return response(502, {"message": "Operation failed; reopen the draft before retrying."})


def read_private_csv(
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


def dispatch(event: dict[str, Any]) -> dict[str, Any]:
    config = storage.StorageConfig.from_environment()
    s3 = storage.client()
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    if method == "GET" and path == "/schedules":
        weeks: dict[int, dict[int, Any]] = {}
        with TemporaryDirectory() as directory:
            for key in storage.list_keys(s3, config):
                match = re.fullmatch(r"data/(\d{4})/week(0[1-9]|1[0-8])\.json", key)
                if not match:
                    continue
                snapshot = storage.read(s3, config, key, required=True)
                if snapshot is None:
                    continue
                local = Path(directory) / "week.json"
                local.write_bytes(snapshot.content)
                games = load_games(local)
                if games:
                    weeks.setdefault(int(match[1]), {})[int(match[2])] = games
        if not weeks:
            return response(404, {"message": "No schedules available"})
        season = max(weeks)
        week = select_active_week(weeks[season]) or max(weeks[season])
        return response(
            200,
            dict(
                seasons={str(s): sorted(w) for s, w in weeks.items()},
                season=season,
                week=week,
                user_id=event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"],
            ),
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
    if method == "GET" and action is None:
        draft = read_private_csv(s3, config, key)
        text = (
            draft.content.decode("utf-8-sig")
            if draft is not None
            else published_csv(json.loads(schedule.content).get("players", []), games)
        )
        return response(
            200,
            {
                **inspect_csv(text, games),
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
    etag = body.get("etag")
    if etag is not None and not isinstance(etag, str):
        raise ValueError("Invalid draft version")
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
    previous = read_private_csv(s3, config, submitted_key)
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
