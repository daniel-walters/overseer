# Overseer

A TUI app that reads PRDs and Issues from a configured root directory and renders them as a live-updating kanban board. See `CONTEXT.md` for domain language and `docs/adr/` for architectural decisions.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues (`daniel-walters/overseer`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role vocabulary, default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
