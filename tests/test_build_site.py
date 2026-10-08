"""Tests for publishing only the public static site and generated documents."""

from pathlib import Path

import pytest

from scripts.build_site import build_site

LICENSE_SOURCES = {
    "LICENSE": '<terms> & "conditions"\n\n    Indented license.\n',
    "LICENSE-SCOPE.md": "# Scope\n\n**Reserved** artwork.\n",
}


def test_site_contains_public_assets_and_json_but_not_private_or_development_files(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for name in ("index.html", "CNAME", "manifest.webmanifest", "LICENSE", "LICENSE-SCOPE.md"):
        (source / name).write_text(name, encoding="utf-8")
    for name, content in LICENSE_SOURCES.items():
        (source / name).write_text(content, encoding="utf-8")
    (source / "RULES.md").write_text("# Rules\n\nCanonical rules.\n", encoding="utf-8")
    (source / "BALLDONTLIE.key").write_text("secret", encoding="utf-8")
    (source / "assets").mkdir()
    (source / "assets" / "app.js").write_text("// public", encoding="utf-8")
    (source / "assets" / "documents").mkdir()
    (source / "assets" / "documents" / "rules.html").write_text("stale", encoding="utf-8")
    (source / "data" / "2026").mkdir(parents=True)
    (source / "data" / "available-weeks.json").write_text("{}", encoding="utf-8")
    (source / "data" / "2026" / "week01.json").write_text("{}", encoding="utf-8")
    (source / "data" / "2026" / "week01.csv").write_text("private import", encoding="utf-8")
    (source / "data" / "raw").mkdir()
    (source / "data" / "raw" / "provider.json").write_text("raw", encoding="utf-8")
    output = tmp_path / "site"

    build_site(source, output)

    assert (output / "assets" / "app.js").exists()
    assert (output / "data" / "2026" / "week01.json").exists()
    assert (output / "data" / "available-weeks.json").exists()
    assert "Canonical rules." in (output / "assets" / "documents" / "rules.html").read_text()
    documents = output / "assets" / "documents"
    assert (documents / "license.html").is_file()
    assert (documents / "license-scope.html").is_file()
    license_html = (documents / "license.html").read_text(encoding="utf-8")
    assert "&lt;terms&gt;" in license_html and "&amp;" in license_html
    assert "<strong>Reserved</strong>" in (documents / "license-scope.html").read_text()
    for name, content in LICENSE_SOURCES.items():
        assert (output / name).read_text(encoding="utf-8") == content
        assert (source / name).read_text(encoding="utf-8") == content
    assert not (output / "BALLDONTLIE.key").exists()
    assert not (output / "data" / "2026" / "week01.csv").exists()
    assert not (output / "data" / "raw").exists()
    assert (source / "assets" / "documents" / "rules.html").read_text() == "stale"


def test_build_replaces_stale_site_files_on_rebuild(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for name in ("index.html", "CNAME", "manifest.webmanifest", "LICENSE", "LICENSE-SCOPE.md"):
        (source / name).touch()
    for name, content in LICENSE_SOURCES.items():
        (source / name).write_text(content, encoding="utf-8")
    (source / "RULES.md").write_text("# Rules\n", encoding="utf-8")
    (source / "assets").mkdir()
    (source / "data").mkdir()
    output = tmp_path / "site"
    output.mkdir()
    (output / "stale.html").touch()

    build_site(source, output)

    assert not (output / "stale.html").exists()

    for name in LICENSE_SOURCES:
        with (source / name).open("a", encoding="utf-8") as document:
            document.write("\nUpdated canonical terms.\n")
    build_site(source, output)
    for name, asset in [("LICENSE", "license.html"), ("LICENSE-SCOPE.md", "license-scope.html")]:
        generated = output / "assets" / "documents" / asset
        assert generated.is_file(), f"Missing regenerated presentation for {name}"
        assert "Updated canonical terms." in generated.read_text(encoding="utf-8")
        assert (output / name).read_bytes() == (source / name).read_bytes()


def test_build_rejects_output_that_contains_source(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    with pytest.raises(ValueError, match="output"):
        build_site(source, tmp_path)
    assert source.exists()
