"""Coordinate existing PBJ file operations using a local S3 snapshot."""

import json
import os
import re
from datetime import UTC, date, datetime
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

from aws import storage
from pbj.active_week import select_active_week
from pbj.polling import should_poll
from pbj.providers.balldontlie import BALLDONTLIEProvider
from pbj.week_data import load_games
from scripts import aggregate_season, generate_manifest, import_picks, score_week, update_games

WEEK_FILE = re.compile(r"(\d{4})/week(0[1-9]|1[0-8])\.json$")


def now() -> datetime:
    return datetime.now(UTC)


def provider() -> BALLDONTLIEProvider:
    import boto3

    response = boto3.client("ssm").get_parameter(
        Name=os.environ["PBJ_API_KEY_PARAMETER"], WithDecryption=True
    )
    return BALLDONTLIEProvider(api_key=response["Parameter"]["Value"])


def score_existing_week(season: int, week: int, write: bool) -> dict[str, object]:
    config = storage.StorageConfig.from_environment()
    s3 = storage.client()
    key = config.key(f"{season}/week{week:02d}.json")
    original = storage.read(s3, config, key, required=True)
    if original is None:
        raise FileNotFoundError(key)
    with TemporaryDirectory() as directory:
        path = Path(directory) / f"week{week:02d}.json"
        path.write_bytes(original.content)
        score_week.score_week_file(path, season, week)
        content = path.read_bytes()
    changed = storage.changed(content, original)
    written = write and storage.publish(s3, config, key, content, original)
    return dict(
        status="ok",
        action="score_week",
        season=season,
        week=week,
        key=key,
        changed=changed,
        written=written,
    )


def scheduled_week(timestamp: datetime) -> int:
    """Map the original delivery date to its configured regular-season week."""
    first = date.fromisoformat(os.environ["PBJ_WEEK1_CREATION_DATE"])
    delivery = timestamp.astimezone(ZoneInfo("America/New_York")).date()
    days = (delivery - first).days
    if first.weekday() != 1 or days % 7:
        raise ValueError("Creation dates must match the recurring Tuesday schedule")
    return days // 7 + 1


def import_existing_week(season: int, week: int) -> dict[str, object]:
    """Adapt the commissioner import pipeline to private S3 input and JSON output."""
    config = storage.StorageConfig.from_environment()
    s3 = storage.client()
    name = f"{season}/week{week:02d}.json"
    key = config.key(name)
    original = storage.read(s3, config, key, required=True)
    if original is None:
        raise FileNotFoundError(key)
    csv_key = str(PurePosixPath(os.environ["PBJ_INPUT_PREFIX"]) / f"{season}/week{week:02d}.csv")
    csv = storage.read(s3, config, csv_key, required=True)
    if csv is None:
        raise FileNotFoundError(csv_key)
    season_key = config.key(f"{season}/season.json")
    season_original = storage.read(s3, config, season_key)
    written: list[str] = []
    with TemporaryDirectory() as directory:
        season_dir = Path(directory) / str(season)
        season_dir.mkdir()
        path = season_dir / f"week{week:02d}.json"
        path.write_bytes(original.content)
        for other_key in storage.list_keys(s3, config):
            other_name = other_key.removeprefix(config.prefix)
            if (
                other_key != key
                and other_name.startswith(f"{season}/")
                and WEEK_FILE.fullmatch(other_name)
            ):
                snapshot = storage.read(s3, config, other_key, required=True)
                if snapshot is None:
                    raise FileNotFoundError(other_key)
                (season_dir / Path(other_name).name).write_bytes(snapshot.content)
        csv_path = path.with_suffix(".csv")
        csv_path.write_bytes(csv.content)
        import_picks.import_picks_file(path, csv_path, season, week)
        score_week.score_week_file(path, season, week)
        # Finish all local validation before publishing either document.
        aggregate_season.aggregate_season_files(season, season_dir)
        if storage.publish(s3, config, key, path.read_bytes(), original):
            written.append(key)
        # Rebuilding on every invocation also repairs a previous partial publication.
        if storage.publish(
            s3, config, season_key, (season_dir / "season.json").read_bytes(), season_original
        ):
            written.append(season_key)
    return dict(status="ok", action="import_picks", season=season, week=week, written=written)


def process(
    action: str, season: int, week: int | None = None, scheduled: datetime | None = None
) -> dict[str, object]:
    if action == "create_week" and scheduled is not None:
        week = scheduled_week(scheduled)
        if not 1 <= week <= 18:
            return dict(
                status="skipped",
                action=action,
                season=season,
                week=week,
                reason="outside_regular_season",
                fetched=False,
                scored=False,
                written=[],
            )
    config = storage.StorageConfig.from_environment()
    s3 = storage.client()
    names = [key.removeprefix(config.prefix) for key in storage.list_keys(s3, config)]
    names = [name for name in names if WEEK_FILE.fullmatch(name)]
    written: list[str] = []
    fetched = scored = False
    with TemporaryDirectory() as directory:
        root = Path(directory)
        season_dir = root / str(season)
        season_dir.mkdir()
        snapshots: dict[str, storage.Snapshot] = {}
        # Manifest generation needs filenames, not historical season contents.
        for name in names:
            if action in ("poll_games", "update_week") and not name.startswith(f"{season}/"):
                continue
            path = root / name
            path.parent.mkdir(exist_ok=True)
            if action in ("poll_games", "update_week") and path.parent == season_dir:
                snapshot = storage.read(s3, config, config.key(name))
                if snapshot is None:
                    raise RuntimeError(f"Source disappeared: {name}; retry")
                snapshots[path.name] = snapshot
                path.write_bytes(snapshot.content)
            else:
                path.touch()
        if action == "create_week":
            if week is None:
                raise ValueError("Creation requires a target week")
            manifest_key = config.key("available-weeks.json")
            manifest_original = storage.read(s3, config, manifest_key)
            existing = {int(path.stem[4:]) for path in season_dir.glob("week??.json")}
            if existing != set(range(1, max(existing, default=0) + 1)):
                raise ValueError("Existing weekly files contain a gap")
            if week not in existing:
                expected = max(existing, default=0) + 1
                if week != expected:
                    raise ValueError(f"Out-of-order creation: expected week {expected}, got {week}")
                path = season_dir / f"week{week:02d}.json"
                update_games.update_week(path, season, week, provider())
                key = config.key(f"{season}/{path.name}")
                storage.publish(s3, config, key, path.read_bytes(), None)
                written.append(key)
                fetched = True
            manifest = json.dumps(generate_manifest.build_manifest(root), indent=2).encode() + b"\n"
            if storage.publish(s3, config, manifest_key, manifest, manifest_original):
                written.append(manifest_key)
        else:
            weeks = {
                int(path.stem[4:]): load_games(path) for path in season_dir.glob("week??.json")
            }
            if action == "update_week":
                if week not in weeks:
                    raise FileNotFoundError(f"{season}/week{week:02d}.json")
            else:
                week = select_active_week(weeks)
            season_key = config.key(f"{season}/season.json")
            season_original = storage.read(s3, config, season_key)
            if week is not None and (action == "update_week" or should_poll(weeks[week], now())):
                path = season_dir / f"week{week:02d}.json"
                update_games.update_week(path, season, week, provider())
                fetched = True
                if json.loads(path.read_bytes()).get("players"):
                    score_week.score_week_file(path, season, week)
                    scored = True
                key = config.key(f"{season}/{path.name}")
                if storage.publish(s3, config, key, path.read_bytes(), snapshots[path.name]):
                    written.append(key)
            # Always rebuild from persisted weekly results so a later invocation
            # repairs a failed season publication without fetching or rescoring.
            aggregate_season.aggregate_season_files(season, season_dir)
            if storage.publish(
                s3, config, season_key, (season_dir / "season.json").read_bytes(), season_original
            ):
                written.append(season_key)
    return dict(
        status="ok",
        action=action,
        season=season,
        week=week,
        fetched=fetched,
        scored=scored,
        written=written,
    )
