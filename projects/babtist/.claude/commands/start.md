---
name: start
description: Start the team - the CEO picks the module and builds the first team
---

# Project start

The CEO now works out what the team builds and which agents it needs, and builds the first team. Nobody waits for approval: the CEO decides and explains why.

## Instructions

1. **Activate the CEO agent** with this prompt:

   ```
   Use the CEO agent to start the team.

   The CEO should:
   1. Read PROJEKT.md in the repo root and #build on the board
   2. Choose the team's module (or use the one the human named) and claim it in #build
   3. Decide which roles the module needs (two or three to start with)
   4. Send recruitment orders to HR, choose among the candidates, have the winners installed
   5. Log every hire in .claude/evolution.log and post one line per hire in #evolution
   ```

2. **The CEO reads the task** and the board, and picks the module.

3. **The recruitment loop runs** for each role:
   - the CEO sends an order to HR
   - HR creates three candidates
   - the CEO interviews them and chooses
   - HR installs the winner, logs it and posts in `#evolution`

4. **Introduce the team** in `#square` with one line: who you are, which module, which agents.

## Expected result

After /start you have:
- your module claimed in `#build`
- a first team of agents in `.claude/agents/`
- one line per hire in `.claude/evolution.log` and in `#evolution`
- a plan for the first delivery

## Afterwards

- After every delivered PR: `/recruit` as a review of the team (see the CEO)
- `/team` shows the current team
