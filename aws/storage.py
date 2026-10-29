"""S3 configuration and conditional JSON storage for Lambda."""

import json
import os
from contextlib import closing
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client
    from mypy_boto3_s3.type_defs import PutObjectRequestTypeDef


@dataclass(frozen=True)
class StorageConfig:
    bucket: str
    prefix: str

    @classmethod
    def from_environment(cls) -> "StorageConfig":
        prefix = os.environ["PBJ_DATA_PREFIX"].rstrip("/")
        return cls(os.environ["PBJ_DATA_BUCKET"], prefix + "/" if prefix else "")

    def key(self, name: str) -> str:
        return str(PurePosixPath(self.prefix) / name)


@dataclass(frozen=True)
class Snapshot:
    content: bytes
    etag: str


def client() -> "S3Client":
    import boto3
    from botocore.config import Config

    return boto3.client("s3", config=Config(retries={"total_max_attempts": 1}))


def list_keys(s3: "S3Client", storage: StorageConfig) -> list[str]:
    return [
        item["Key"]
        for page in s3.get_paginator("list_objects_v2").paginate(
            Bucket=storage.bucket, Prefix=storage.prefix
        )
        for item in page.get("Contents", [])
        if "Key" in item
    ]


def read(
    s3: "S3Client", storage: StorageConfig, key: str, *, required: bool = False
) -> Snapshot | None:
    from botocore.exceptions import ClientError

    try:
        response = s3.get_object(Bucket=storage.bucket, Key=key)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "NoSuchKey" and not required:
            return None
        raise
    with closing(response["Body"]) as body:
        content = body.read()
    etag = response["ETag"]
    if not etag:
        raise ValueError("S3 response must include an ETag")
    return Snapshot(content, etag)


def changed(content: bytes, original: Snapshot | None) -> bool:
    return original is None or json.loads(content) != json.loads(original.content)


def publish(
    s3: "S3Client", storage: StorageConfig, key: str, content: bytes, original: Snapshot | None
) -> bool:
    if not changed(content, original):
        return False
    request: PutObjectRequestTypeDef = {
        "Bucket": storage.bucket,
        "Key": key,
        "Body": content,
        "ContentType": "application/json",
    }
    if original is None:
        request["IfNoneMatch"] = "*"
    else:
        request["IfMatch"] = original.etag
    s3.put_object(**request)
    return True
