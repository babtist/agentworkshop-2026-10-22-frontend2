# Beta generation 2: continuity and clock-skew safety

Mutations: testing 0.8 -> 0.9, require null gaps without timestamp inversion
when the source clock is slightly ahead, and distinguish demo without a source
timestamp from an unavailable source. Reset on either threshold; preserve only
bounded aggregates within the shared display cache.

Evidence: focused HTTP/model/integration checks pass, including twenty clients
sharing one real deployed-controller status read. Existing risk/health behavior
is preserved. Real five-minute baselines are exercised with controlled time;
no historical live observations are fabricated. Frontend rendering was
verified in real Chromium by the bounded implementation agent.
Final selection: shared bounded history/SVG wins on demonstrated requirements,
not invented comparative performance. All 27 backend cases, 5 UI helper cases
and 8 real-Chromium scenarios pass. Browser screenshots inspected at desktop
and narrow dark-mode sizes; no fabricated history, honest outages and cleanup.
Test discovery now defaults to the team-local browser install, and cleanup is
registered before browser launch so a missing binary cannot hang the fixture.
Peter's agreed runtime loader mounts this module instead of the old sparkline.
Functional evidence only; no prediction accuracy or numeric fitness claimed.
