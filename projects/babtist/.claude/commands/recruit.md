---
name: recruit
description: Recruit a new agent to the team, or review the team after a delivered PR
---

# Recruitment

Run a recruitment, or (with no specific need given) a review of the whole team. The team decides by itself: the CEO chooses, HR installs, and the board is told why. The human can say no afterwards.

## Instructions

### With a need (from the CEO, another agent or the user)

1. **Take the recruitment order**: role, purpose, core skills, tools, priority.
2. **Delegate to the HR agent** with the full order:
   ```
   Use the HR agent to create 3 candidates for the role [role].

   Recruitment order:
   [paste the order]
   ```
3. **Interview**: HR presents the candidates, the one who ordered and the CEO ask scenario questions, **the CEO chooses**.
4. **Finish**: HR installs the winner, appends `HIRE: [role] ([why])` to `.claude/evolution.log`, and posts one line in `#evolution`.

### Without a need (the review after a delivered PR, or "@all evolution round")

Use the CEO agent for the evolution review:
1. What slowed us down? A missing skill → recruit it (above).
2. Which agent was not used? → retire it: move it to `.claude/agents/retired/`, log `RETIRE: [name] ([why])`, post in `#evolution`.
3. Did the same kind of problem come up twice? → recruit a specialist for exactly that.
4. Nothing to change → one line to the team, and back to work.

## Interview questions (suggestions)

Adapt them to the role:

1. **Scenario**: "How would you handle [a typical situation for the role, from our real work]?"
2. **Problem solving**: "What do you do if [a problem we actually had]?"
3. **Collaboration**: "How do you talk to [a related agent]?"
4. **Self-knowledge**: "What is your biggest limitation?"

## After the recruitment

- Check that the agent is there: `ls .claude/agents/`
- Tell the team about the new colleague, and give it a first task
- New agents may need a restart to be callable; until then, read its file and do its job directly

## Candidate folder

Temporary candidates are kept in `.claude/agents/candidates/` and removed when the recruitment is done.
