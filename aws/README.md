# Initial shadow Lambda deployment

The manual workflow deploys only `test/aws-upgrade` to the existing
`pbj-shadow-smoke` function in `us-east-2`, using the `aws-staging` environment's
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets.

The archive contains the installed `pbj` package, production dependencies, the
handler, and the explicitly listed operational scripts. It excludes repository
data, credentials, tests, frontend assets, and site/document generation scripts.
The handler only checks module imports; it does not fetch games, import picks,
score data, or persist anything. No S3 access is included.

## First deployment

After separately reviewing, committing, and pushing these changes to
`test/aws-upgrade`, dispatch the workflow for that branch:

```sh
gh workflow run deploy-aws-shadow.yml --ref test/aws-upgrade
```

GitHub normally requires a `workflow_dispatch` workflow to exist on the default
branch before it can be dispatched. If this new workflow has never been registered
there, GitHub may reject the command or omit the Run workflow button. That is a
GitHub prerequisite, not something this local implementation changes; resolve it
separately before the first run. This implementation does not change `main` or add
an automatic push trigger.

The workflow runs the Python suite, checks imports from the staged artifact,
updates code, and sets runtime `python3.14` and handler
`lambda_function.lambda_handler`. Each AWS update is followed by a waiter that
fails on a failed update or timeout. It updates `$LATEST`; no version or alias is
published. The existing function must use ZIP packaging.

## Permissions

The deployment identity needs `lambda:UpdateFunctionCode`, `lambda:GetFunction`
(used by the waiter), and **`lambda:UpdateFunctionConfiguration`** on the existing
function ARN. No S3, resource creation, `iam:PassRole`, or Lambda invocation
permission is needed: the workflow does not change the execution role or invoke
the function. Keep the function's existing execution role; normal CloudWatch
logging permissions on that role are needed if invocation logs are desired.

For a separate manual smoke invocation, use event `{}` and expect `status: ok`
with the operational module names. The caller would additionally need
`lambda:InvokeFunction`.
