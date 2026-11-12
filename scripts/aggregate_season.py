"""Rebuild PBJ season aggregates from weekly results."""

import argparse
import json
import logging
import re
from pathlib import Path
from typing import Any

from pbj.scoring import PlayerResult, WeekResult
from pbj.season import SeasonPlayerResult, SeasonResult, aggregate_season

logger = logging.getLogger(__name__)

WEEK_FILE_PATTERN = re.compile(r"week(\d{2})\.json$")


def main() -> None:
    """Rebuild season aggregates."""
    args = _parse_args()

    season_dir = Path(f"data/{args.season}")

    aggregate_season_files(
        season=args.season,
        season_dir=season_dir,
    )


def aggregate_season_files(
    season: int,
    season_dir: Path,
) -> None:
    """Rebuild season.json from weekly result files."""
    weeks, names_by_week = _load_week_results(
        season=season,
        season_dir=season_dir,
    )

    result = aggregate_season(
        season=season,
        weeks=weeks,
    )

    display_names: dict[str, str] = {}
    for week in result.weeks_scored:
        display_names.update(names_by_week[week])

    season_path = season_dir / "season.json"

    _write_json_atomic(
        path=season_path,
        data=_season_result_to_dict(result, display_names),
    )

    logger.info(
        "Aggregated %d completed week(s) for season %d",
        len(result.weeks_scored),
        season,
    )

    logger.info(
        "Updated %s",
        season_path,
    )


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Rebuild PBJ season aggregates.")

    parser.add_argument(
        "season",
        type=int,
        help="NFL season year",
    )

    return parser.parse_args()


def _load_week_results(
    season: int,
    season_dir: Path,
) -> tuple[list[tuple[int, WeekResult]], dict[int, dict[str, str]]]:
    """Load derived weekly results for a season."""
    if not season_dir.exists():
        return [], {}

    names_by_week: dict[int, dict[str, str]] = {}
    weeks: list[tuple[int, WeekResult]] = []

    for path in sorted(season_dir.glob("week*.json")):
        week_number = _week_number_from_path(path)

        if week_number is None:
            continue

        data = _load_json_object(path)

        existing_season = data.get("season")

        if existing_season != season:
            raise ValueError(f"{path} contains season {existing_season}, expected {season}")

        existing_week = data.get("week")

        if existing_week != week_number:
            raise ValueError(f"{path} contains week {existing_week}, expected {week_number}")

        raw_results = data.get("results")

        if raw_results is None:
            logger.info(
                "Skipping week %d because it has no results",
                week_number,
            )
            continue

        if not isinstance(raw_results, dict):
            raise ValueError(f"{path} results field must be a JSON object")

        names_by_week[week_number] = {}
        for player in data.get("players", []) or []:
            if not isinstance(player, dict) or not isinstance(player.get("id"), str):
                continue
            for field in ("nickname", "name"):
                value = player.get(field)
                if isinstance(value, str) and value.strip():
                    names_by_week[week_number][player["id"]] = value
                    break

        weeks.append(
            (
                week_number,
                _week_result_from_dict(raw_results),
            )
        )

    return weeks, names_by_week


def _week_number_from_path(
    path: Path,
) -> int | None:
    """Extract the football week number from a weekly filename."""
    match = WEEK_FILE_PATTERN.fullmatch(path.name)

    if match is None:
        return None

    return int(match.group(1))


def _load_json_object(
    path: Path,
) -> dict[str, Any]:
    """Load a JSON object from disk."""
    try:
        with path.open(encoding="utf-8") as file:
            data: Any = json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} does not contain valid JSON") from exc

    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")

    return data


def _week_result_from_dict(
    data: dict[str, Any],
) -> WeekResult:
    """Build a WeekResult from weekly JSON results."""
    raw_players = data.get("players")

    if not isinstance(raw_players, list):
        raise ValueError("weekly results players field must be a list")

    raw_winners = data.get("weekly_winners")

    if not isinstance(raw_winners, list):
        raise ValueError("weekly results weekly_winners field must be a list")

    weekly_winners: list[str] = []

    for winner in raw_winners:
        if not isinstance(winner, str):
            raise ValueError("weekly results contain invalid winner ID")

        weekly_winners.append(winner)

    players = tuple(_player_result_from_dict(player) for player in raw_players)

    return WeekResult(
        monday_total=_optional_int(data.get("monday_total")),
        player_count=_required_int(
            data.get("player_count"),
            "weekly results contain invalid player_count",
        ),
        weekly_winners=tuple(weekly_winners),
        players=players,
    )


def _player_result_from_dict(
    data: Any,
) -> PlayerResult:
    """Build one PlayerResult from weekly JSON results."""
    if not isinstance(data, dict):
        raise ValueError("weekly results contain invalid player data")

    player_id = data.get("player_id")

    if not isinstance(player_id, str):
        raise ValueError("weekly results contain invalid player ID")

    return PlayerResult(
        player_id=player_id,
        wins=_required_int(
            data.get("wins"),
            "weekly results contain invalid wins",
        ),
        losses=_required_int(
            data.get("losses"),
            "weekly results contain invalid losses",
        ),
        ties=_required_int(
            data.get("ties"),
            "weekly results contain invalid ties",
        ),
        missed_picks=_required_int(
            data.get("missed_picks"),
            "weekly results contain invalid missed_picks",
        ),
        accuracy=_optional_number(data.get("accuracy")),
        tiebreaker_distance=_optional_number(data.get("tiebreaker_distance")),
        weekly_rank=_optional_int(data.get("weekly_rank")),
        weekly_winner=_required_bool(
            data.get("weekly_winner"),
            "weekly results contain invalid weekly_winner",
        ),
    )


def _required_int(
    value: Any,
    message: str,
) -> int:
    """Parse a required integer."""
    if isinstance(value, bool) or not isinstance(
        value,
        int,
    ):
        raise ValueError(message)

    return int(value)


def _optional_int(
    value: Any,
) -> int | None:
    """Parse an optional integer."""
    if value is None:
        return None

    if isinstance(value, bool) or not isinstance(
        value,
        int,
    ):
        raise ValueError(f"invalid optional integer: {value!r}")

    return int(value)


def _optional_number(
    value: Any,
) -> float | None:
    """Parse an optional numeric value."""
    if value is None:
        return None

    if isinstance(value, bool) or not isinstance(
        value,
        int | float,
    ):
        raise ValueError(f"invalid optional number: {value!r}")

    return float(value)


def _required_bool(
    value: Any,
    message: str,
) -> bool:
    """Parse a required boolean."""
    if not isinstance(value, bool):
        raise ValueError(message)

    return value


def _season_result_to_dict(
    result: SeasonResult,
    display_names: dict[str, str],
) -> dict[str, Any]:
    """Convert SeasonResult into normalized JSON data."""
    return {
        "season": result.season,
        "weeks_scored": list(result.weeks_scored),
        "players": [_season_player_to_dict(player, display_names) for player in result.players],
    }


def _season_player_to_dict(
    result: SeasonPlayerResult,
    display_names: dict[str, str],
) -> dict[str, Any]:
    """Convert one season player result into JSON data."""
    return {
        "player_id": result.player_id,
        "display_name": display_names.get(
            result.player_id,
            " ".join(part[:1].upper() + part[1:] for part in result.player_id.split("-")),
        ),
        "weeks_played": result.weeks_played,
        "wins": result.wins,
        "losses": result.losses,
        "ties": result.ties,
        "missed_picks": result.missed_picks,
        "accuracy": result.accuracy,
        "weekly_wins": result.weekly_wins,
        "last_place_finishes": result.last_place_finishes,
    }


def _write_json_atomic(
    path: Path,
    data: dict[str, Any],
) -> None:
    """Write season JSON without risking a partial file."""
    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    temp_path = path.with_suffix(".json.tmp")

    with temp_path.open(
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            data,
            file,
            indent=2,
            ensure_ascii=False,
        )
        file.write("\n")

    temp_path.replace(path)


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    main()
