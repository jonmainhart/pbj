"""Import commissioner picks into one PBJ weekly JSON file."""

import argparse
import json
import logging
from pathlib import Path
from typing import Any

from pbj.domain.game import Game
from pbj.domain.player import Player
from pbj.importers.numbers import import_players
from pbj.week_data import games_from_week_data, load_validated_week

logger = logging.getLogger(__name__)


def main() -> None:
    """Import player picks for one NFL week."""
    args = _parse_args()

    week_path = Path(f"data/{args.season}/week{args.week:02d}.json")

    csv_path = (
        Path(args.csv)
        if args.csv is not None
        else _default_csv_path(
            season=args.season,
            week=args.week,
        )
    )

    import_picks_file(
        week_path=week_path,
        csv_path=csv_path,
        season=args.season,
        week=args.week,
    )


def import_picks_file(
    week_path: Path,
    csv_path: Path,
    season: int,
    week: int,
) -> None:
    """Import picks and update only the players section of weekly JSON."""
    week_data = load_validated_week(
        path=week_path,
        season=season,
        week=week,
    )

    games = games_from_week_data(week_data)

    if not games:
        raise ValueError("weekly JSON does not contain game data")

    if not csv_path.exists():
        raise FileNotFoundError(f"{csv_path} does not exist")

    with csv_path.open(
        "r",
        encoding="utf-8",
        newline="",
    ) as csv_file:
        players = import_players(
            csv_file,
            games,
        )

    if not players:
        raise ValueError("CSV did not contain any players")

    non_pick_count = _count_non_picks(
        players=players,
        games=games,
    )

    # This script owns only player data.
    week_data["players"] = [_player_to_dict(player) for player in players]

    _write_json_atomic(
        path=week_path,
        data=week_data,
    )

    # The CSV is temporary input. It must only disappear after the
    # normalized JSON has been successfully persisted.
    _remove_imported_csv(csv_path)

    logger.info(
        "Imported %d players for %d week %d",
        len(players),
        season,
        week,
    )

    if non_pick_count:
        logger.warning(
            "Imported week contains %d non-pick(s)",
            non_pick_count,
        )

    logger.info(
        "Updated %s",
        week_path,
    )


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Import PBJ player picks from a Numbers CSV export."
    )

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

    parser.add_argument(
        "--csv",
        help=("Optional CSV path. Defaults to data/<season>/weekNN.csv."),
    )

    return parser.parse_args()


def _default_csv_path(
    season: int,
    week: int,
) -> Path:
    """Return the normal commissioner CSV path for one week."""
    return Path(f"data/{season}/week{week:02d}.csv")


def _player_to_dict(
    player: Player,
) -> dict[str, Any]:
    """Convert one imported Player into normalized JSON."""
    return {
        "id": player.id,
        "name": player.name,
        "nickname": player.nickname,
        "picks": dict(player.picks),
        "tiebreaker": player.tiebreaker,
    }


def _count_non_picks(
    players: list[Player],
    games: list[Game],
) -> int:
    """Count intentionally omitted picks across all players."""
    expected_game_ids = {game.id for game in games}

    return sum(len(expected_game_ids - set(player.picks)) for player in players)


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


def _remove_imported_csv(
    csv_path: Path,
) -> None:
    """Remove CSV input after its picks were successfully persisted."""
    csv_path.unlink()

    logger.info(
        "Removed imported CSV %s",
        csv_path,
    )


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    main()
