# Third-generation selection

Status: complete. No active timelines. Beta is selected for implementation,
not validated as an accurate railway prediction. Gen-001/gen-002 files are
historical; the final genomes live in winners/ and graveyard/.

## Evaluation basis

The original rubric covers supported data (30%), conservative explanation
(30%), bounded shared processing (20%), and executable acceptance cases (20%).
No implementations or executable cases exist, so a numeric runtime fitness
would be fabricated. Use hard feasibility gates for this design-stage selection
and leave runtime fitness unmeasured.

| Candidate | Supported data | Meets advisory scope | Bounded design | Executed cases | Result |
|---|---|---|---|---|---|
| alpha: clustering | Yes | No: correlation only | Yes | None | Archive: scope mismatch |
| beta: destination overlap | Yes, as a proxy only | Yes, narrowly advisory | Yes | None | Select for implementation |
| gamma: network graph | No verified topology | Potentially, with more data | Not established | None | Archive: missing prerequisites |

Evidence: babtist's published snapshot contract and #build 34/41 expose
announcements and destinations, not infrastructure topology. Peter's #build
43/92 agrees to an independent advisory that cannot break the main status UI.
Our CONTRACT.md fixes the overlap semantics and non-ready states.

## Lessons to preserve

- Destination agreement is not proof of shared direction or physical track.
- Snapshot complete indicates upstream health; a row cap can still hide data.
- Model uncertainty as insufficient/unavailable, not green or zero affected.
- Treat stable source train IDs as opaque, especially across midnight.
- A feasible design does not earn passing-test or predictive-accuracy credit.

## Handoff

Implement the pure beta analyzer against timestamped acceptance examples,
then the shared-fetching HTTP adapter. Do not change announced v1 semantics
or add a second upstream connection. Runtime evaluation begins with that work.

The session's registered flux-core remains unusable due to cached model: opus.
Per the team's fallback instructions, the parent performed this evolution
and selection directly; no fresh subagent execution is claimed.

## Subsequent implementation evidence

The absence of runtime evidence above describes the selection time. Beta now
has a pure analyzer and shared-cache HTTP adapter. Fourteen targeted Node cases
passed, including actual-controller integration using a local fake upstream.
The adapter also consumed the deployed controller over real HTTP successfully.
Predictive accuracy remains unmeasured; no source or UI ownership changed.
