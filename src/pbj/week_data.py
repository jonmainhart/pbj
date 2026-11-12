"""Read weekly documents and convert their games into domain objects."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from pbj.domain.game import Game, GameStatus, Team


def load_games(path: Path) -> list[Game]:
    """Load games from weekly data file."""
    if not path.exists():
        raise FileNotFoundError(f"Weekly data does not exist: {path}")

    raw: Any = json.loads(path.read_text(encoding="utf-8"))

    return parse_games(raw)


def parse_games(raw: Any) -> list[Game]:
    """Convert an already decoded weekly document using the file loader rules."""
    if not isinstance(raw, dict):
        raise ValueError("Weekly JSON must contain an object")

    games = raw.get("games")

    if not isinstance(games, list):
        raise ValueError("Weekly JSON does not contain game data")

    return [_parse_game(game) for game in games]


def _parse_game(raw: Any) -> Game:
    if not isinstance(raw, dict):
        raise ValueError("Game must be an object")

    return Game(
        id=str(raw["id"]),
        scheduled_time=datetime.fromisoformat(str(raw["scheduled_time"])),
        away=_parse_team(raw["away"]),
        home=_parse_team(raw["home"]),
        status=GameStatus(str(raw["status"])),
        away_score=_optional_int(raw.get("away_score")),
        home_score=_optional_int(raw.get("home_score")),
    )


def _parse_team(raw: Any) -> Team:
    if not isinstance(raw, dict):
        raise ValueError("Team must be an object")

    return Team(
        id=str(raw["id"]),
        abbreviation=str(raw["abbreviation"]),
        name=str(raw["name"]),
    )


def _optional_int(
    value: Any,
) -> int | None:
    if value is None:
        return None

    return int(value)


def load_validated_week(
    path: Path,
    season: int,
    week: int,
) -> dict[str, Any]:
    """Load and validate an existing weekly JSON document."""
    if not path.exists():
        raise FileNotFoundError(f"{path} does not exist")

    try:
        with path.open(
            encoding="utf-8",
        ) as file:
            data: Any = json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} does not contain valid JSON") from exc

    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")

    existing_season = data.get("season")
    existing_week = data.get("week")

    if existing_season != season:
        raise ValueError(f"{path} contains season {existing_season}, expected {season}")

    if existing_week != week:
        raise ValueError(f"{path} contains week {existing_week}, expected {week}")

    return data


def games_from_week_data(
    week_data: dict[str, Any],
) -> list[Game]:
    """Convert games for import and scoring, requiring integer or absent scores."""
    raw_games = week_data.get("games")

    if raw_games is None:
        return []

    if not isinstance(raw_games, list):
        raise ValueError("weekly JSON games field must be a list")

    games: list[Game] = []

    for raw_game in raw_games:
        if not isinstance(raw_game, dict):
            raise ValueError("weekly JSON contains invalid game data")

        away = raw_game.get("away")
        home = raw_game.get("home")

        if not isinstance(away, dict):
            raise ValueError("weekly JSON contains invalid away team data")

        if not isinstance(home, dict):
            raise ValueError("weekly JSON contains invalid home team data")

        games.append(
            Game(
                id=str(raw_game["id"]),
                scheduled_time=datetime.fromisoformat(str(raw_game["scheduled_time"])),
                away=Team(
                    id=str(away["id"]),
                    abbreviation=str(away["abbreviation"]),
                    name=str(away["name"]),
                ),
                home=Team(
                    id=str(home["id"]),
                    abbreviation=str(home["abbreviation"]),
                    name=str(home["name"]),
                ),
                status=GameStatus(str(raw_game["status"])),
                away_score=_strict_score(raw_game.get("away_score")),
                home_score=_strict_score(raw_game.get("home_score")),
            )
        )

    return games


def _strict_score(
    value: Any,
) -> int | None:
    """Parse an optional integer from weekly JSON."""
    if value is None:
        return None

    if isinstance(value, bool) or not isinstance(
        value,
        int,
    ):
        raise ValueError(f"invalid game score: {value!r}")

    return int(value)
