"""Small S3 adapter for PBJ weekly scoring and deployment import checks."""

import json
import os
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from scripts import (
    aggregate_season,
    generate_manifest,
    import_picks,
    score_week,
    select_active_week,
    should_poll,
    update_games,
)


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """Score an existing S3 week; the empty event retains the import smoke check."""
    if not isinstance(event, dict):
        raise ValueError("event must be an object")
    if event:
        return _score_week(event)
    return {
        "status": "ok",
        "modules": [
            module.__name__
            for module in (
                aggregate_season,
                generate_manifest,
                import_picks,
                score_week,
                select_active_week,
                should_poll,
                update_games,
            )
        ],
    }


def _s3_client() -> Any:
    # Keep AWS dependencies confined to the deployment adapter. Smoke checks need no SDK.
    import boto3
    from botocore.config import Config

    # Never retry an upload using results calculated from an earlier snapshot.
    return boto3.client("s3", config=Config(retries={"total_max_attempts": 1}))


def _score_week(event: dict[str, Any]) -> dict[str, Any]:
    if event.get("action") != "score_week":
        raise ValueError("action must be score_week")
    season, week = event.get("season"), event.get("week")
    write = event.get("write", False)
    if type(season) is not int or not 1900 <= season <= 9999:
        raise ValueError("season must be an integer from 1900 to 9999")
    if type(week) is not int or not 1 <= week <= 18:
        raise ValueError("week must be an integer from 1 to 18")
    if type(write) is not bool:
        raise ValueError("write must be a boolean")
    bucket = os.environ["PBJ_DATA_BUCKET"]
    prefix = os.environ.get("PBJ_DATA_PREFIX", "data/")
    if prefix != "data/":
        raise ValueError("PBJ_DATA_PREFIX must be data/")
    key = f"{prefix}{season}/week{week:02d}.json"
    s3 = _s3_client()
    response = s3.get_object(Bucket=bucket, Key=key)
    with closing(response["Body"]) as body:
        original_bytes = body.read()
    etag = response["ETag"]
    if not isinstance(etag, str) or not etag:
        raise ValueError("S3 response must include an ETag")
    original = json.loads(original_bytes)
    with TemporaryDirectory() as directory:
        path = Path(directory) / f"week{week:02d}.json"
        path.write_bytes(original_bytes)
        score_week.score_week_file(path=path, season=season, week=week)
        scored_bytes = path.read_bytes()
        changed = json.loads(scored_bytes) != original
    written = write and changed
    if written:
        s3.put_object(
            Bucket=bucket,
            Key=key,
            Body=scored_bytes,
            ContentType="application/json",
            IfMatch=etag,
        )
    return {
        "status": "ok",
        "action": "score_week",
        "season": season,
        "week": week,
        "key": key,
        "changed": changed,
        "written": written,
    }
