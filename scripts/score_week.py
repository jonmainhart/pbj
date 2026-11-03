"""Score one PBJ football week."""

import argparse
import json
import logging
from pathlib import Path
from typing import Any

from pbj.domain.player import Player
from pbj.scoring import PlayerResult, WeekResult
from pbj.scoring import score_week as calculate_week
from pbj.week_data import games_from_week_data, load_validated_week

logger = logging.getLogger(__name__)


def main() -> None:
    """Score one NFL week."""
    args = _parse_args()

    week_path = Path(f"data/{args.season}/week{args.week:02d}.json")

    score_week_file(
        path=week_path,
        season=args.season,
        week=args.week,
    )


def score_week_file(
    path: Path,
    season: int,
    week: int,
) -> None:
    """Calculate and persist derived results for one weekly file."""
    week_data = load_validated_week(
        path=path,
        season=season,
        week=week,
    )

    games = games_from_week_data(week_data)
    players = _players_from_week_data(week_data)

    if not games:
        raise ValueError("weekly JSON does not contain game data")

    if not players:
        raise ValueError("weekly JSON does not contain player data")

    result = calculate_week(
        games=games,
        players=players,
    )

    # This script owns only derived weekly results.
    week_data["results"] = _week_result_to_dict(result)

    _write_json_atomic(
        path=path,
        data=week_data,
    )

    logger.info(
        "Scored %d players for %d week %d",
        result.player_count,
        season,
        week,
    )

    if result.weekly_winners:
        logger.info(
            "Weekly winner(s): %s",
            ", ".join(result.weekly_winners),
        )
    else:
        logger.info("Weekly winner not yet determined")

    logger.info(
        "Updated %s",
        path,
    )


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Score one PBJ football week.")

    parser.add_argument(
        "season",
        type=int,
        help="NFL season year",
    )

    parser.add_argument(
        "week",
        type=int,
        help="NFL regular-season week",
    )

    return parser.parse_args()


def _players_from_week_data(
    week_data: dict[str, Any],
) -> list[Player]:
    """Build normalized Player objects from weekly JSON."""
    raw_players = week_data.get("players")

    if raw_players is None:
        return []

    if not isinstance(raw_players, list):
        raise ValueError("weekly JSON players field must be a list")

    players: list[Player] = []

    for raw_player in raw_players:
        if not isinstance(raw_player, dict):
            raise ValueError("weekly JSON contains invalid player data")

        raw_picks = raw_player.get("picks")

        if not isinstance(raw_picks, dict):
            raise ValueError("weekly JSON contains invalid player picks")

        picks: dict[str, str] = {}

        for game_id, pick in raw_picks.items():
            if not isinstance(
                game_id,
                str,
            ) or not isinstance(
                pick,
                str,
            ):
                raise ValueError("weekly JSON contains invalid player pick")

            picks[game_id] = pick

        players.append(
            Player(
                id=str(raw_player["id"]),
                name=str(raw_player["name"]),
                nickname=_optional_string(raw_player.get("nickname")),
                picks=picks,
                tiebreaker=_number(raw_player.get("tiebreaker")),
            )
        )

    return players


def _optional_string(
    value: Any,
) -> str | None:
    """Parse an optional string from weekly JSON."""
    if value is None:
        return None

    if not isinstance(value, str):
        raise ValueError(f"invalid optional string: {value!r}")

    return value


def _number(
    value: Any,
) -> float:
    """Parse a numeric value from weekly JSON."""
    if isinstance(
        value,
        bool,
    ) or not isinstance(
        value,
        int | float,
    ):
        raise ValueError(f"invalid numeric value: {value!r}")

    return float(value)


def _week_result_to_dict(
    result: WeekResult,
) -> dict[str, Any]:
    """Convert derived WeekResult into weekly JSON data."""
    return {
        "monday_total": result.monday_total,
        "player_count": result.player_count,
        "weekly_winners": list(result.weekly_winners),
        "players": [_player_result_to_dict(player) for player in result.players],
    }


def _player_result_to_dict(
    result: PlayerResult,
) -> dict[str, Any]:
    """Convert one PlayerResult into weekly JSON data."""
    return {
        "player_id": result.player_id,
        "wins": result.wins,
        "losses": result.losses,
        "ties": result.ties,
        "missed_picks": result.missed_picks,
        "accuracy": result.accuracy,
        "tiebreaker_distance": (result.tiebreaker_distance),
        "weekly_rank": result.weekly_rank,
        "weekly_winner": result.weekly_winner,
    }


def _write_json_atomic(
    path: Path,
    data: dict[str, Any],
) -> None:
    """Write weekly JSON without risking a partial file."""
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
