# PBJ Dashboard

PBJ is a mobile-friendly dashboard for a weekly football pool. It imports the commissioner's spreadsheet, retrieves NFL schedules and scores, calculates weekly and season results, and displays them on a public website. Players do not need accounts; the AWS commissioner portal requires an authorized account.

The repository contains infrastructure-independent Python domain logic (`src/pbj/`), reusable processing scripts (`scripts/`), AWS integration (`aws/`), and the static dashboard and commissioner portal (`site/`). Player-facing rules are in [RULES.md](RULES.md).

GitHub Pages serves production from `main`. The `test/aws-upgrade` branch develops an independent AWS preview, including the commissioner portal. AWS parallel validation and production cutover remain tracked in [#71](https://github.com/jonmainhart/pbj/issues/71) and [#72](https://github.com/jonmainhart/pbj/issues/72).

For local setup, building, and tests, see [DEVELOPMENT.md](DEVELOPMENT.md). For AWS deployment, access, commissioner operations, and recovery, see [aws/README.md](aws/README.md).

## License

Source and project documentation use the [Apache License 2.0](LICENSE). Participant data, PBJ artwork and branding, and third-party material have separate terms; see [LICENSE-SCOPE.md](LICENSE-SCOPE.md) and [LEGAL.md](LEGAL.md).
