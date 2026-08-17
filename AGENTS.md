# LeadRadar project rules

## Versioning

- `package.json` is the canonical application version.
- Releases use Semantic Versioning and annotated Git tags named `vX.Y.Z`.
- Before a release, the API version, README version, package version, changelog
  section and Git tag must agree.
- `README.md` is a stable product and operations template. Do not use it as a
  chronological diary. Change it only when the public product contract, setup,
  API or current release changes.
- Record every material change to business logic, data sources, licensing,
  search, deduplication, scoring, website-status interpretation, persistence,
  export, API contracts or security in `changes_log.md` in the same commit.
- Put planned work and status changes in `ROADMAP.md`, not in README.

## Release discipline

- Add material changes under `Unreleased` first.
- PATCH fixes behavior without changing business rules or public contracts.
- MINOR adds a backward-compatible capability or changes product logic.
- MAJOR changes a public contract, data model or workflow incompatibly.
- Never commit real API keys, `.env.local`, raw provider responses or lead data.
- A release requires passing lint, build and tests before tagging.

## Yandex live data

- Keep Yandex live UI disabled by default.
- A smoke test must be transient: no raw response files, browser storage,
  database writes or CSV export.
- Do not enable storage, enrichment, reordering, scoring, export or display on a
  third-party map until the applicable license is confirmed in writing.

## Agent skills

### Issue tracker

Issues and specifications are tracked in GitHub Issues for
`2303850Analyst/lead-radar`. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the canonical triage labels `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, and `wontfix`. See
`docs/agents/triage-labels.md`.

### Domain docs

The repository uses a single-context domain documentation layout. See
`docs/agents/domain.md`.
