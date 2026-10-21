# Initial shadow Lambda deployment

The workflow deploys only `test/aws-upgrade` to the existing
`pbj-shadow-smoke` function in `us-east-2`, using the `aws-staging` environment's
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets.

The archive contains the installed `pbj` package, production dependencies, the
handler, and the explicitly listed operational scripts. It excludes repository
data, credentials, tests, frontend assets, and site/document generation scripts.
The handler only checks module imports; it does not fetch games, import picks,
score data, or persist anything. No S3 access is included.

## First deployment

After separately reviewing and committing these changes, push to
`test/aws-upgrade` to trigger the first deployment automatically. Subsequent pushes
deploy when they change `.github/workflows/deploy-aws-shadow.yml`, `aws/**`,
`src/pbj/**`, `scripts/**`, or `pyproject.toml`.

Manual deployment remains available once the workflow exists on the default
branch. Dispatch it for the test branch with:

```sh
gh workflow run deploy-aws-shadow.yml --ref test/aws-upgrade
```

The workflow runs the Python suite, checks imports from the staged artifact,
and updates code only. Waiters before and after the code update fail on a failed
update or timeout. It updates `$LATEST`; no version or alias is published. The
existing function must use ZIP packaging, runtime `python3.14`, and handler
`lambda_function.lambda_handler`. These are prerequisites; the workflow does not
change Lambda configuration.

## Permissions

The deployment identity needs `lambda:UpdateFunctionCode` and `lambda:GetFunction`
(used by the waiter) on the existing function ARN. The existing policy also allows
`lambda:GetFunctionConfiguration`; no additional permissions are required.
No `lambda:UpdateFunctionConfiguration`, S3, resource creation, `iam:PassRole`, or
Lambda invocation permission is needed: the workflow does not change the execution role or invoke
the function. Keep the function's existing execution role; normal CloudWatch
logging permissions on that role are needed if invocation logs are desired.

For a separate manual smoke invocation, use event `{}` and expect `status: ok`
with the operational module names. The caller would additionally need
`lambda:InvokeFunction`.
