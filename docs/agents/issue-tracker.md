# Issue tracker: GitHub

Issues and specifications for this repository live as GitHub issues. Use the
`gh` CLI from the repository clone; it resolves the repository from `origin`.

## Conventions

- Create: `gh issue create --title "..." --body-file "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Apply a label: `gh issue edit <number> --add-label "..."`
- Remove a label: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use files or safe standard input for multiline issue bodies. Do not place API
keys, customer data, raw provider responses, or lead data in issues.

## Pull requests as a triage surface

PRs as a request surface: no.

A pull request explicitly named by the user may still be inspected directly,
but external PRs are not included in automatic triage discovery.

## Publishing operations

- “Publish to the issue tracker” means creating a GitHub issue.
- “Fetch the relevant ticket” means reading the issue and its comments.
- Specifications produced by `/to-spec` receive the `ready-for-agent` label.
- Infer the repository from the current clone.

## Wayfinding operations

A wayfinding map is a GitHub issue labelled `wayfinder:map`. Decision tickets
are linked as sub-issues where supported, otherwise through a task list and a
`Part of #<map>` reference.

Use native issue dependencies where available. If unavailable, represent
blocking relationships with a `Blocked by: #<number>` line. Claim work by
assigning the issue to the current GitHub user.
