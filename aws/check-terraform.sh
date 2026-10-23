#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
terraform -chdir=aws/terraform fmt -check
terraform -chdir=aws/terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=aws/terraform validate
