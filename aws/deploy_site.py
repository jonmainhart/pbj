"""Upload the shared public build to the static preview bucket only."""

import mimetypes
from pathlib import Path
from typing import Protocol

import boto3

from scripts.build_site import PUBLIC_FILES

BUCKET = "pbj-preview-jm26"
STATIC_FILES = {
    "index.html",
    "admin/index.html",
    "manifest.webmanifest",
    *PUBLIC_FILES,
}
ASSET_SUFFIXES = {".js", ".css", ".html", ".json", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp"}


class UploadClient(Protocol):
    def upload_file(
        self, Filename: str, Bucket: str, Key: str, ExtraArgs: dict[str, str]
    ) -> None: ...


def upload_site(client: UploadClient, artifact: Path) -> None:
    """Select static files from build/site; never sync or delete operational objects."""
    for path in sorted(artifact.rglob("*")):
        relative = path.relative_to(artifact)
        if relative.as_posix() == "assets/admin-config.json":
            continue  # Terraform owns the public authentication configuration.
        if not path.is_file() or path.is_symlink():
            continue
        if relative.as_posix() not in STATIC_FILES and not (
            relative.parts[0] == "assets" and path.suffix.lower() in ASSET_SUFFIXES
        ):
            continue
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        client.upload_file(
            str(path),
            BUCKET,
            relative.as_posix(),
            ExtraArgs={"ContentType": content_type, "CacheControl": "no-cache"},
        )


if __name__ == "__main__":
    upload_site(boto3.client("s3"), Path("build/site"))
