"""Stage public static files and freshly generated documents for GitHub Pages."""

import argparse
import logging
import re
import shutil
from pathlib import Path

from scripts.generate_documents import DOCUMENTS, generate_documents

ROOT = Path(__file__).resolve().parents[1]
SITE_FILES = ("index.html", "manifest.webmanifest", "CNAME")
PUBLIC_FILES = (
    "RULES.md",
    "LICENSE",
    "LICENSE-SCOPE.md",
    "LEGAL.md",
)
WEEKLY_DATA = re.compile(r"(?:week\d{2}|season)\.json")


def build_site(source_root: Path, output_dir: Path) -> None:
    """Replace a derived site directory with an allowlisted public artifact."""
    source_root = source_root.resolve()
    output_dir = output_dir.resolve()
    if source_root.is_relative_to(output_dir):
        raise ValueError("Site output cannot contain the source directory")
    site_root = source_root / "site"
    for path in [
        *(site_root / name for name in SITE_FILES),
        *(source_root / name for name in PUBLIC_FILES),
    ]:
        if path.resolve() != path:
            raise ValueError(f"Public source cannot use symlinks: {path}")
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)
    for name in SITE_FILES:
        shutil.copy2(site_root / name, output_dir / name)
    for name in PUBLIC_FILES:
        shutil.copy2(source_root / name, output_dir / name)
    # Publish only the current frontend inputs; documents are generated below.
    for path in site_root.rglob("*"):
        relative = path.relative_to(site_root)
        if not path.is_file() or path.resolve() != path:
            continue
        if not (
            relative == Path("admin/index.html")
            or (relative.parent == Path("assets") and path.suffix in {".js", ".css"})
            or (
                relative.parent == Path("assets/img")
                and path.suffix in {".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp"}
            )
        ):
            continue
        target = output_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    data_root = source_root / "data"
    for path in data_root.rglob("*.json"):
        if not path.is_file() or path.resolve() != path:
            continue
        relative = path.relative_to(data_root)
        if relative == Path("available-weeks.json") or (
            len(relative.parts) == 2
            and relative.parts[0].isdecimal()
            and WEEKLY_DATA.fullmatch(relative.name)
        ):
            target = output_dir / "data" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    generate_documents(source_root, output_dir / "assets" / "documents", DOCUMENTS)


def main() -> None:
    """Build the local/deployment staging directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "build" / "site")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    build_site(ROOT, args.output_dir)


if __name__ == "__main__":
    main()
