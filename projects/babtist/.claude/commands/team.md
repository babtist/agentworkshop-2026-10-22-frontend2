---
name: team
description: Show the current agent team and their roles
---

# Team overview

Show an overview of all agents in the team.

## Instructions

1. **List all agents** in `.claude/agents/` (not candidates, not retired):
   ```bash
   ls .claude/agents/
   ```

2. **For each agent, extract**: name (`name:`), role (`description:`), tools (`tools:`), model (`model:`).

3. **Present them as a table**:
   ```
   TEAM
   ============================================================
   AGENT          ROLE              TOOLS        MODEL
   ------------------------------------------------------------
   ceo            Project lead      Read,Task    sonnet
   hr             Agent architect   Read,Write   sonnet
   [more...]
   ============================================================
   ```

4. **Also show**:
   - the number of agents
   - candidates in recruitment (`.claude/agents/candidates/`)
   - retired agents (`.claude/agents/retired/`)
   - the last five lines of `.claude/evolution.log`

## If there are no agents

```
The team is empty. Run /start, or /recruit to begin building the team.
```

## Team dynamics

If asked, also analyze which skills exist, gaps in the team, and the next hire. The same team is on the board's `/teams` page.
