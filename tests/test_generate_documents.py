"""Contracts for rendering complete project documents."""

import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

from scripts.generate_documents import DOCUMENTS, Document, generate_documents, render_document


class ParsedHTML(HTMLParser):
    """Inspect semantic output without depending on serializer whitespace."""

    def __init__(self, content: str) -> None:
        super().__init__()
        self.tags: list[str] = []
        self.text: list[str] = []
        self.links: list[str] = []
        self.feed(content)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        if tag == "a":
            self.links.extend(value for name, value in attrs if name == "href" and value)

    def handle_data(self, data: str) -> None:
        self.text.append(data)


@pytest.mark.unit
@pytest.mark.parametrize(
    ("source_name", "asset_name"),
    [("LICENSE", "license.html"), ("LICENSE-SCOPE.md", "license-scope.html")],
)
def test_registered_license_documents_render_complete_canonical_sources(
    tmp_path: Path,
    source_name: str,
    asset_name: str,
) -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / source_name).read_bytes()

    generate_documents(root, tmp_path, DOCUMENTS)

    asset = tmp_path / asset_name
    assert asset.is_file(), f"Missing generated presentation for {source_name}"
    parsed = ParsedHTML(asset.read_text(encoding="utf-8"))
    text = "".join(parsed.text)
    if source_name == "LICENSE":
        assert parsed.tags == ["pre"]
        assert text == source.decode("utf-8")
    else:
        assert {"h1", "h2", "p", "a"} <= set(parsed.tags)
        for paragraph in source.decode("utf-8").split("\n\n"):
            # Strip only the formatting used by this document.
            expected = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", paragraph)
            expected = re.sub(r"^#{1,6} ", "", expected).replace("`", "")
            assert " ".join(expected.split()) in " ".join(text.split())
    assert (root / source_name).read_bytes() == source


@pytest.mark.unit
def test_markdown_renders_the_entire_document_with_semantic_formatting() -> None:
    source = (
        "# A Document\n\nOpening paragraph.\n\n"
        "## First Section\n\n- **Bold** and *emphasis* with `code` ✅\n"
        "- [Source](./RULES.md)\n\n"
        "## Last Section\n\n1. First item\n2. Last item\n\nClosing paragraph.\n"
    )
    parsed = ParsedHTML(render_document(source, "markdown"))

    assert {"h1", "h2", "p", "ul", "ol", "li", "strong", "em", "code", "a"} <= set(parsed.tags)
    text = "".join(parsed.text)
    for expected in (
        "Opening paragraph.",
        "First Section",
        "Last Section",
        "✅",
        "Closing paragraph.",
    ):
        assert expected in text
    assert parsed.links == ["./RULES.md"]


@pytest.mark.unit
def test_plain_text_is_escaped_and_preserves_whitespace() -> None:
    source = 'License <terms> & "conditions"\n\n    Indented text\n'
    parsed = ParsedHTML(render_document(source, "text"))

    assert "pre" in parsed.tags
    assert "terms" not in parsed.tags
    assert "".join(parsed.text) == source


@pytest.mark.unit
def test_generation_supports_multiple_documents_without_modifying_sources(tmp_path: Path) -> None:
    source_root = tmp_path / "source"
    source_root.mkdir()
    sources = {"RULES.md": "# Rules\n\nEntire rules.\n", "LICENSE": "Terms <reserved>\n"}
    for name, content in sources.items():
        (source_root / name).write_text(content, encoding="utf-8")
    output = tmp_path / "generated"

    generate_documents(
        source_root,
        output,
        [
            Document(name="rules", source="RULES.md", format="markdown"),
            Document(name="license", source="LICENSE", format="text"),
        ],
    )

    assert {path.name for path in output.iterdir()} == {"rules.html", "license.html"}
    assert "Entire rules." in "".join(ParsedHTML((output / "rules.html").read_text()).text)
    assert "".join(ParsedHTML((output / "license.html").read_text()).text) == sources["LICENSE"]
    for name, content in sources.items():
        assert (source_root / name).read_text(encoding="utf-8") == content


@pytest.mark.unit
def test_generation_is_deterministic_and_source_edits_replace_derived_content(
    tmp_path: Path,
) -> None:
    source = tmp_path / "RULES.md"
    source.write_text("# Rules\n\nOriginal rule.\n", encoding="utf-8")
    output = tmp_path / "generated"
    documents = [Document(name="rules", source="RULES.md", format="markdown")]
    generate_documents(tmp_path, output, documents)
    original = (output / "rules.html").read_bytes()
    generate_documents(tmp_path, output, documents)
    assert (output / "rules.html").read_bytes() == original

    source.write_text("# Rules\n\nUpdated rule.\n", encoding="utf-8")
    generate_documents(tmp_path, output, documents)
    updated = (output / "rules.html").read_text(encoding="utf-8")
    assert "Updated rule." in updated
    assert "Original rule." not in updated


@pytest.mark.unit
def test_real_rules_document_is_rendered_in_full(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "RULES.md").read_text(encoding="utf-8")
    generate_documents(
        root, tmp_path, [Document(name="rules", source="RULES.md", format="markdown")]
    )
    text = "".join(ParsedHTML((tmp_path / "rules.html").read_text(encoding="utf-8")).text)

    for heading in re.findall(r"^#{1,6} (.+)$", source, flags=re.MULTILINE):
        assert heading in text
    assert source.strip().splitlines()[-1] in text
    assert "✅" in text and "❌" in text and "👑" in text
    assert "Game Data Provider" not in text


@pytest.mark.unit
def test_missing_source_fails_generation(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        generate_documents(
            tmp_path,
            tmp_path / "generated",
            [
                Document(name="rules", source="missing.md", format="markdown"),
            ],
        )


@pytest.mark.unit
@pytest.mark.parametrize("content", ["", " \n\t"])
def test_empty_document_is_rejected(content: str) -> None:
    with pytest.raises(ValueError, match="empty"):
        render_document(content, "markdown")


@pytest.mark.unit
def test_unsupported_format_is_rejected() -> None:
    with pytest.raises(ValueError, match="format"):
        render_document("A document", "unsupported")
