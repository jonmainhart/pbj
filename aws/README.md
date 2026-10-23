# Permanent AWS deployment

Only pushes to `test/aws-upgrade` deploy AWS. Existing main-branch Pages and
operational workflows are unchanged. No AWS changes are made by local checks.

## Ownership and resources

`terraform.yml` calls the existing reusable quality workflow, runs Terraform
1.17.0 formatting and validation, creates a saved plan, checks its JSON, applies
that exact plan, then calls `deploy-aws.yml` to package Python and update code.
The entire sequence shares concurrency group `pbj-aws-deployment` with cancellation
disabled. The deploy workflow has no standalone push or dispatch trigger.
GitHub may replace pending runs; every run uses its own checked-out commit.

Terraform creates:

- `pbj-processor`: Python 3.14, x86_64, 256 MB, 60 seconds, existing import-check handler.
- `pbj-lambda-execution`: Lambda service trust only.
- Inline role policy `pbj-operational-data`: logging to its own group, prefix-scoped
  listing and GetObject/PutObject under `s3://pbj-data-jm26/data/`. No object deletion.
- `/aws/lambda/pbj-processor`: 30-day log retention.

There are no bucket resources, operational object uploads, triggers, or data copies.
The existing bucket's settings and `PowerUserRole` are untouched. Terraform uses
`terraform/pbj.tfstate` and native `terraform/pbj.tfstate.tflock` locking. It never
writes `data/`. The Lambda role cannot access Terraform state.

Terraform owns function configuration and uses a deterministic, failing placeholder
ZIP only at creation. It ignores subsequent filename/hash changes; GitHub owns
application code. Destruction protection covers the function, role and log group;
the plan guard rejects every managed deletion/replacement, including policy deletion.
The guard permits in-place updates: these still require normal code review before push.
No separate approval gate pauses the automatic apply.

The handler currently checks operational-module imports only. It does not fetch,
score, import picks, read environment variables, or persist S3 data. Infrastructure
and artifact deployment verification do not prove data-processing parity. Future
AWS orchestration belongs under `aws/`, reusing the existing scripts. AWS's own
independently seeded `data/` dataset must be compared with repository production
results during parallel operation. Deployment never seeds or overwrites picks/JSON.

## One-time manual setup before pushing

1. Review and commit these local changes on `test/aws-upgrade` yourself. Do not
   import or rename `pbj-shadow-smoke`. Confirm the four permanent names do not
   already exist; an existing unmanaged name must be reviewed before proceeding.
2. Make private copies of `iam/terraform-user.json` and `iam/deploy-user.json`
   and replace `ACCOUNT_ID` in those copies with the actual 12-digit account ID.
   Keep the placeholders in the repository templates. These are complete identity policy
   documents for this configuration, not Terraform-managed IAM users.
3. Manually create `pbj-github-terraform` and attach the Terraform policy. It
   grants state read/write, lock read/write/delete, scoped role/configuration
   management and PassRole to Lambda only. It intentionally grants no resource
   deletion or Lambda code update. AWS STS GetCallerIdentity needs no allow.
   `logs:DescribeLogGroups` requires wildcard scope. Role policy management lets
   this identity change that role's permissions; protect its credentials accordingly.
4. Update `pbj-github-deploy` with the deploy policy targeting `pbj-processor`.
   It needs only code update and function reads; it has no PassRole or S3 access.
   Retain smoke-function access only until its manual retirement if still needed.
5. Manually create two GitHub environments with the following environment secrets:

   | Environment | IAM identity | Environment secrets |
   | --- | --- | --- |
   | `pbj-aws-infra` | `pbj-github-terraform` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
   | `pbj-aws-deploy` | `pbj-github-deploy` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

   Each environment must permit only `test/aws-upgrade` using its deployment
   branch restrictions. Store each user's access key pair only in its corresponding
   environment. Do not use repository-level fallback credentials. Configure no
   required reviewers or other approval gates for this automatic sequence.
   Terraform uses `pbj-aws-infra`; the reusable application workflow's deploy job
   uses `pbj-aws-deploy`. The new workflows do not use `aws-staging` or the previous
   `AWS_TERRAFORM_*` secret names. No OIDC or role assumption is required.
6. Verify existing bucket encryption and policies allow the two exact state/lock
   keys. If it uses a customer-managed KMS key, the Terraform identity additionally
   needs `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey` on that exact key and
   its key policy must allow it. The Lambda role similarly needs Decrypt for reads
   and GenerateDataKey for writes if operational objects use that key. No key ARN
   is assumed or wildcard KMS permission granted. Resolve this before first run.
7. Push only after review. Quality → validation → plan → guard → saved-plan apply
   → artifact import check → code update → Lambda update waiter and hash check.
   A failed code deployment leaves the initial placeholder failing closed; rerun
   the complete workflow after fixing the issue. Partial infrastructure failures
   are recovered through state and another complete run, never by deleting state.
8. Manually invoke `{}` with a separate operator identity allowing
   `lambda:InvokeFunction`, expecting `status: ok`. Retire `pbj-shadow-smoke`
   manually only after replacement verification. No automated invocation is granted.

No manual AWS setup was performed by this implementation. An SCP, permission
boundary, bucket policy or key policy can deny otherwise allowed operations.
If denied, record the exact action/resource and ask the account administrator;
do not bypass the restriction or attach AdministratorAccess. Changing retention
can expire older logs. Provider validation cannot prove account-level permissions.

## Bootstrap IAM review

The lock file pins `hashicorp/aws` to **6.70.0**. The policy includes
`iam:ListRoleTags` only on `pbj-lambda-execution` to cover the provider's role-tag
enumeration helper. Its normal role read obtains tags from `GetRole`, so a
separate ListRoleTags call is not required on every refresh. Role reads also
inspect inline and attached policies; their scoped read permissions are retained.
The separate inline-policy resource uses GetRolePolicy and PutRolePolicy.
Lambda reads require GetFunction, ListVersionsByFunction and, for ZIP functions
in this region, GetFunctionCodeSigningConfig. Log-group reads use DescribeLogGroups
and ListTagsForResource. The existing policies cover these operations.

This is a source review, not a live IAM authorization test. State access remains
limited to the state and lock keys; no state deletion is granted. KMS and explicit
deny concerns described above remain account-specific prerequisites.

Provider sources at the pinned tag:
[role and tag handling](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/iam/role.go),
[inline policy](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/iam/role_policy.go),
[Lambda](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/lambda/function.go),
[log group](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/logs/group.go),
[log tags](https://github.com/hashicorp/terraform-provider-aws/blob/v6.70.0/internal/service/logs/tags_gen.go).

## Local checks

```sh
terraform version  # must be 1.17.0
bash aws/check-terraform.sh
python aws/bootstrap.py
python -m pytest
```

The shared check initializes providers with `-backend=false` and never contacts
S3 state. Commit `aws/terraform/.terraform.lock.hcl`; refresh intentionally with
`terraform -chdir=aws/terraform init -backend=false -upgrade`, then
`terraform -chdir=aws/terraform providers lock -platform=darwin_amd64 -platform=linux_amd64`.
Review provider updates before committing the lock file.

The existing private local `.git/hooks/pre-commit` hook may call
`bash aws/check-terraform.sh` for Terraform edits. Hook integration has not been
verified or installed automatically as part of these corrections. No hook file
is created, modified, replaced, or tracked. CI remains authoritative.
Do not run `terraform apply` locally. An AWS-backed plan is deliberately reserved
for GitHub after bootstrap. `.gitignore` explicitly excludes
`aws/terraform/bootstrap.zip` and also excludes ZIP archives, saved plans, state
files, and `.terraform/` provider binaries. Never commit these generated files
or credentials. Keep `aws/terraform/.terraform.lock.hcl` in version control; it
is not ignored (and must be added with the other implementation files before push).

References: [S3 backend permissions and native locking](https://developer.hashicorp.com/terraform/language/backend/s3),
[shared ownership with ignore_changes](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle),
[Lambda resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/lambda_function).
