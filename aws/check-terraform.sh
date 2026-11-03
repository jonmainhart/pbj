#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

terraform -chdir=aws/terraform fmt -check -recursive

if [[ ! -d aws/terraform/.terraform/providers ]]; then
    terraform -chdir=aws/terraform init \
        -backend=false \
        -input=false \
        -lockfile=readonly
fi

terraform -chdir=aws/terraform validate
terraform -chdir=aws/terraform test -filter=tests/scheduler.tftest.hcl
