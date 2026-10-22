# Gamma generation 2: bound persisted retention

Mutation: require 30-minute IndexedDB expiry and an accessible text equivalent
to every canvas state, including gaps and non-current data.
Feasibility review: possible but adds storage/lifecycle/accessibility machinery
without shared history across viewers. Not implemented; runtime unmeasured.

Archived at selection: extra retention and accessibility work is not justified.
Resurrect for offline browsing only when persistence is a real requirement.
