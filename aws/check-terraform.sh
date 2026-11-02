#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Formatting requires no initialization.
terraform -chdir=aws/terraform fmt -check

# Use an isolated Terraform data directory for QA.
# Never reuse the real infrastructure backend configuration.
qa_data_dir="$(mktemp -d)"
trap 'rm -rf "$qa_data_dir"' EXIT

export TF_DATA_DIR="$qa_data_dir"

terraform -chdir=aws/terraform init \
  -backend=false \
  -reconfigure \
  -input=false \
  -lockfile=readonly

terraform -chdir=aws/terraform validate