# Domain Docs

LeadRadar uses a single-context domain documentation layout.

## Before exploring

Read, when present:

- `CONTEXT.md` at the repository root;
- relevant ADRs under `docs/adr/`.

If these files do not exist, proceed silently. Domain-modeling workflows create
them lazily when terminology or a durable architectural decision needs to be
recorded.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   ├── agents/
│   └── adr/
└── application modules
```

## Vocabulary

Use terms defined in `CONTEXT.md` consistently in specifications, issues, tests,
and architecture discussions. If a required concept is absent, reconsider
whether it is implementation terminology or a genuine domain-model gap.

## Architectural decisions

Read ADRs relevant to the area before proposing changes. If a proposal
contradicts an accepted ADR, surface the conflict explicitly rather than
silently overriding the earlier decision.
