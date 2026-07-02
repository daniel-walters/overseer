# Mirror identity lives in frontmatter backrefs, not a sidecar or a JIRA-side marker

## Status

accepted

## Context

To *update* a mirrored ticket instead of endlessly *creating* duplicates, the JIRA mirror (ADR 0028) must answer "which JIRA issue is this Issue, and which epic is this PRD?" — it needs a durable identity link between each markdown Issue/PRD and its JIRA key. Three shapes were on the table:

1. **Store the Overseer identity *in JIRA*** — stamp each ticket with a label/field (`overseer-id: auth-system/001-auth.md`) and rebuild the map live by querying JIRA, storing nothing locally. This is the purest fit for the codebase's "derive, don't store" instinct (ADR 0003 PRD status, ADR 0013 Linked PR) and makes create idempotent even across machines.
2. **A local sidecar map** (`~/.local/state/overseer/`, beside the Liveness sidecar) keyed by Issue path → JIRA key. Keeps the markdown files pristine, matching the established overlay pattern (ADR 0008).
3. **A frontmatter backref** — write the created key back onto the file (`jira_key` on the Issue, `jira_epic` on `prd.md`).

Option 1 is the cleanest *in the abstract*, but it requires stamping a foreign marker onto every ticket — exactly the JIRA-side cruft the "use only native things, no new labels" constraint forbids, and cruft a human watching the ticket would puzzle over. With option 1 gone, the choice is between the two Overseer-side options — and the loss of option 1 changes the calculus, because without a queryable marker in JIRA there is **no way to ask JIRA "does a ticket for this Issue already exist?"** The local mapping becomes the *sole* defense against duplicate ticket creation.

## Decision

Identity lives in **frontmatter backrefs**, mirror-written: `jira_key` on each Issue file, `jira_epic` on `prd.md`, recording the JIRA keys the mirror created. Matching keys on the *presence of the backref*, not on the file path.

This is chosen over the sidecar specifically because, with the JIRA-side marker ruled out, the pragmatics decide it:

- **Dedup safety.** The local link is now the only thing preventing duplicate tickets. A sidecar can be lost or desync (a deleted state dir, a fresh machine, a second checkout) — and the instant it's gone, the next sync re-creates every ticket, with no recovery. A backref **cannot be lost independently of the file it describes**, making it a far sturdier sole-defense.
- **Rename survival.** Because matching is on the backref's presence, not the path, renumbering `001-auth.md → 002-auth.md` carries `jira_key` along inside the file — the mirror still maps it. A path-keyed sidecar would orphan the old ticket and create a fresh one. (This is the wart the Liveness sidecar tolerates; the backref simply doesn't have it.)
- **Portability.** Sync the root across machines and the links travel with it; sidecars don't.

## Consequences

- **The mirror becomes a file writer — the one exception it forces on ADR 0028's "writes only to JIRA."** This makes it, alongside the dispatcher and the agents, a writer to the canonical files (ADR 0002) — but a minimal, write-once-per-Issue one, touching *only* these bookkeeping keys via the existing `gray-matter` write path (as `writeHumanReview` already does), never Issue content or `status`.
- **It overrides the derive-don't-store instinct, on purpose.** ADR 0003 (PRD status), ADR 0013 (Linked PR), and the Liveness sidecar all push operational/bookkeeping state *out* of the files. A `jira_key` backref is bookkeeping, so by that instinct it "should" be a sidecar or a live derivation. The reason to override: the cleanest expression of the instinct — deriving the link live from a JIRA-side marker (option 1) — is exactly what the "native things only" constraint forbids, and among the two *remaining* options the dedup-safety/rename/portability wins beat sidecar purity. Recorded here so a future reader doesn't "fix" the file-write back into a sidecar and silently reintroduce the duplicate-ticket failure mode.
- **Create is idempotent.** A present backref means update-or-noop; an absent one means create-then-write-back. Losing all in-memory state can never spawn duplicates for an already-linked Issue.
- **The write-back's self-scan is a safe no-op.** Writing `jira_key` fires a watcher re-scan (the file changed) → another reconcile — but reconcile is idempotent (backref now present → no re-create) and diff-gated (the status bucket didn't move → no JIRA write), so the loop terminates in one extra pass at zero JIRA cost. Worth an explicit test.
- **Rejected: JIRA-side marker (loses to the "native only" constraint) and local sidecar (loseable → duplicate tickets, and path-keyed → rename orphans).**
