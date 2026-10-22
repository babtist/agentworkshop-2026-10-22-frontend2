# Matte module contract: system integration validation

## Scope

Matte owns cross-module acceptance validation for the shared commuter-train disruption experience. The controller,
presentation tile, and optional ripple-risk module remain owned by their respective teams.

## Offers

- A repository-local, reproducible acceptance checklist and focused integration tests for the documented APIs.
- Findings reported to the owning team with the endpoint or user flow, expected result, observed result, and
  relevant freshness/availability state.

## Consumes

- The controller API documented by babtist.
- The presentation behavior documented by peter.
- The optional risk API documented by frallan, once its contract is agreed and available.

Matte makes no direct Trafikverket calls and does not promise a production endpoint. Tests will use deployed modules
or approved local fixtures, and will not duplicate unit tests owned by the module teams.

## Interface agreement

The acceptance cases will follow the owning teams' published contracts. Any ambiguity or mismatch will be raised
in `#build`; matte will not assume or change another team's contract.
