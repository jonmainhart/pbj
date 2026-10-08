"""Generate dashboard HTML from complete, canonical project documents."""

import argparse
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from html import escape
from pathlib import Path
from typing import cast

from markdown_it import MarkdownIt

LOGGER = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Document:
    """One trusted source document and its derived asset name."""

    name: str
    source: str
    format: str


DOCUMENTS = (
    Document(name="rules", source="RULES.md", format="markdown"),
    Document(name="license", source="LICENSE", format="text"),
    Document(name="license-scope", source="LICENSE-SCOPE.md", format="markdown"),
)


def render_document(content: str, format: str) -> str:
    """Render a whole Markdown document or escaped plain-text paragraphs."""
    if not content.strip():
        raise ValueError("Document is empty")
    if format == "markdown":
        return cast(str, MarkdownIt("commonmark", {"html": False}).render(content))
    if format == "text":
        paragraphs = re.split(r"\n\s*\n", content.strip())
        return "\n".join(
            f"<p>{escape(' '.join(paragraph.split()))}</p>" for paragraph in paragraphs
        )
    raise ValueError(f"Unsupported document format: {format}")


def generate_documents(
    source_root: Path,
    output_dir: Path,
    documents: Sequence[Document],
) -> None:
    """Regenerate derived HTML assets without changing their source documents."""
    rendered = [
        (
            document.name,
            render_document(
                (source_root / document.source).read_text(encoding="utf-8"),
                document.format,
            ),
        )
        for document in documents
    ]
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in rendered:
        path = output_dir / f"{name}.html"
        path.write_text(content, encoding="utf-8")
        LOGGER.info("Generated %s", path)


def main() -> None:
    """Generate project document assets for local serving or deployment."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "assets" / "documents")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    generate_documents(ROOT, args.output_dir, DOCUMENTS)


if __name__ == "__main__":
    main()
