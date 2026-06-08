---
name: overseer-grill-with-docs
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree, while maintaining the domain docs (CONTEXT.md + docs/adr/) of the code repos in the session. Use when the user wants to stress-test a plan or design before writing a PRD, or mentions "grill me".
---

Interview the user relentlessly about every aspect of their plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

This is the **upstream** of the Overseer authoring pipeline: a good grilling session leaves behind the shared understanding (and the repo `repo:` / AFK-vs-HITL decisions) that `/overseer-to-prd` and `/overseer-to-issues` later synthesize into a PRD and Issues. Keep this skill pure — interview and maintain domain docs. Do **not** write a PRD or create Issues here; that's the producer skills' job, working from the conversation you produce.

## Domain awareness

During codebase exploration, also look for existing documentation in **each code repo in the session**.

This skill is **multi-root aware.** Your session typically spans several code repos — the directory you launched in plus any added with `/add-dir` — because the feature's work spans them. Domain docs live **with their code**: each repo keeps its own `CONTEXT.md` + `docs/adr/`. When a concept belongs to repo A, read and write repo A's docs; for a concept in repo B, use repo B's. If it's unclear which repo a concept belongs to, ask.

(Note: the PRD and Issue artifacts that `/overseer-to-prd` and `/overseer-to-issues` later produce do **not** live in any code repo — they live in the Overseer root. Domain docs stay with the code; only the PRD/Issue files go to the root.)

### File structure

Within a single repo, most have a single context:

```
<repo>/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `CONTEXT-MAP.md` exists at a repo's root, that repo has multiple contexts. The map points to where each one lives:

```
<repo>/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
```

Create files lazily — only when you have something to write, in the repo the concept belongs to. If no `CONTEXT.md` exists in that repo, create one when the first term is resolved. If no `docs/adr/` exists there, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in that repo's `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update the owning repo's `CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

Don't couple `CONTEXT.md` to implementation details. Only include terms that are meaningful to domain experts.

### Offer ADRs sparingly

Only offer to create an ADR (in the owning repo's `docs/adr/`) when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).
