"""Focused contracts for issue #45's canonical legal notice and public build."""

from pathlib import Path

from scripts.build_site import build_site
from scripts.generate_documents import DOCUMENTS, generate_documents, render_document

ROOT = Path(__file__).resolve().parents[1]
NOTICE = "# Legal Notice\n\nTest notice. [Licensing Scope](LICENSE-SCOPE.md).\n"


def test_real_legal_notice_is_generated_from_canonical_source(tmp_path: Path) -> None:
    source = (ROOT / "LEGAL.md").read_text(encoding="utf-8")
    generate_documents(ROOT, tmp_path, DOCUMENTS)
    assert (tmp_path / "legal.html").read_text(encoding="utf-8") == render_document(
        source, "markdown"
    )


def test_registered_legal_notice_is_generated_from_source(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for document in DOCUMENTS:
        (source / document.source).write_text("# Fixture\n", encoding="utf-8")
    legal = source / "LEGAL.md"
    legal.write_text(NOTICE, encoding="utf-8")
    output = tmp_path / "documents"

    generate_documents(source, output, DOCUMENTS)

    asset = output / "legal.html"
    assert asset.is_file(), "Legal Notice must participate in registered document generation"
    assert asset.read_text(encoding="utf-8") == render_document(NOTICE, "markdown")
    legal.write_text(NOTICE + "\nUpdated canonical notice.\n", encoding="utf-8")
    generate_documents(source, output, DOCUMENTS)
    assert "Updated canonical notice." in asset.read_text(encoding="utf-8")
    assert legal.read_text(encoding="utf-8").endswith("Updated canonical notice.\n")


def test_public_build_retains_legal_source_and_generates_presentation(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for name in (
        "index.html", "CNAME", "manifest.webmanifest", "RULES.md", "LICENSE", "LICENSE-SCOPE.md"
    ):
        (source / name).write_text("Fixture content\n", encoding="utf-8")
    (source / "LEGAL.md").write_text(NOTICE, encoding="utf-8")
    (source / "assets" / "documents").mkdir(parents=True)
    (source / "assets" / "documents" / "legal.html").write_text("stale", encoding="utf-8")
    (source / "data").mkdir()
    output = tmp_path / "site"

    build_site(source, output)

    assert (output / "LEGAL.md").is_file(), "Public artifact must retain canonical LEGAL.md"
    assert (output / "LEGAL.md").read_bytes() == (source / "LEGAL.md").read_bytes()
    assert (output / "assets" / "documents" / "legal.html").read_text() == render_document(
        NOTICE, "markdown"
    )
    assert (output / "LICENSE-SCOPE.md").is_file()
