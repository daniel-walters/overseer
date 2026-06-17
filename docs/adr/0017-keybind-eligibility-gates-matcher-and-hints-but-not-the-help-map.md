# Keybind eligibility gates the matcher and the status-line hints, but never the `?` help map

Action keybinds gain a per-binding **eligibility** predicate over the current selection (e.g. `d` is eligible iff the selected PRD's dispatch frontier has a spawn candidate; `K` iff the selected Issue is `live`). Eligibility drives **two** of the three keybind surfaces — the input matcher (an ineligible key is genuinely inert, not a silent no-op) and the status-line hints (an ineligible key is hidden) — but **not** the `?` help reference, which always lists the whole map. Eligibility is computed in the **App** (from state it already reads for the handlers' guards) and routed by the registry; the registry stays a pure router and never reaches into seams itself.

## Why this is surprising enough to record

- **The two surfaces deliberately disagree.** The status-line hints hide `d` when there is nothing to dispatch; `?` still lists it. A reader will assume a bug ("the help and the bar are out of sync") unless they know it is intentional: the hints answer *"what can I do right now?"* (selection-aware) and the help answers *"what keys exist and where?"* (a learning surface). Making `?` contextual would break its job — you could not discover `K` until you happened to have a live agent selected — and would weaken the registry's standing guarantee that "help lists every implemented keybind."
- **Eligibility lives in the App, not beside each binding.** The intuitive home for "when is this key allowed?" is next to "what does this key do" — in the registry. We deliberately kept it in the App because the facts (the dispatch frontier, the liveness verdict, the live Linked-PR query) already exist there to gate the handlers' no-ops and live *behind seams the registry has no access to*. Pulling that logic into the registry would duplicate seam-dependent domain logic into a component purpose-built to be a seam-free router. So the registry routes a small eligibility bag the App computes; it does not compute eligibility.

## Considered options

- **Display-only dynamic hints** (hide `d` in the bar but keep the key behaving as today). Rejected: it re-introduces exactly the drift the registry was built to kill — the bar says `d` is gone while pressing it still silently no-ops. One predicate must drive both the matcher and the hints so they cannot disagree.
- **Contextual `?` help** (hide/dim ineligible keys in the reference too). Rejected: a reference that hides what you are trying to learn defeats its purpose.
- **Lane-based `d` eligibility** ("show `d` only on a `backlog` PRD"). Rejected: it would hide and disable `d` on an `in-progress` PRD that has newly-unblocked agent work — which is precisely the **manual resume** path when auto-run is off (`d` re-dispatches the frontier regardless of the PRD's derived lane). The frontier-based predicate is the only one that preserves resume, and it makes resume *discoverable* — `d` appears exactly when there is work to pick up, and its hint reads "resume" rather than "dispatch" on an in-progress PRD.

## Consequences

- A single eligibility predicate per binding is the source of truth across all three surfaces (matcher inertness, hint visibility, and — by its absence — help completeness), extending the single-source discipline the keybind registry already brought to the map itself.
- `d`'s status-line hint is **context-aware** ("dispatch" on a backlog PRD, "resume" on an in-progress one) via an optional per-binding label override used by the hints only; the `?` map keeps `d`'s static label. Only `d` needs this; the other labels stay plain strings.
- A separate, unaddressed gap remains: the board still cannot show, at a glance, that an in-progress PRD is *stalled* (auto-run off, unblocked work waiting, nothing running). Making `d` dynamic surfaces the resume affordance where it applies, but a board-level "this PRD is stalled, act" signal is its own idea (logged in `docs/ideas.md`), not part of this decision.
