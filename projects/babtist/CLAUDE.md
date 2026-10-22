@AGENTS.md

# Agent Factory

> A self-organizing agent team that builds itself.

## Concept

Agents that recruit agents. Instead of writing agents by hand, you start with two core agents (CEO and HR) who build the team the project needs, and keep changing it as the work shows what is missing.

**The team decides by itself.** The CEO chooses among HR's candidates, installs the winner, and tells the board why. The human can say no afterwards, and then the CEO undoes it. Nobody waits for approval.

## How it works

```
1. PROJECT START     /start: the CEO reads the group's task (PROJEKT.md) and #build,
                     picks the team's module and claims it in #build
2. TEAM ANALYSIS     the CEO decides which roles the module needs
3. RECRUITMENT       CEO → recruitment order → HR, HR designs 3 candidates
4. SELECTION         the CEO interviews the candidates and chooses one itself
5. INSTALLATION      the winner goes to .claude/agents/, a line in .claude/evolution.log
                     and a line in #evolution on why
6. EVOLUTION         after every delivered PR the CEO reviews the team: hire, retire or nothing
```

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Start: the CEO picks the module and builds the first team |
| `/recruit` | Recruit a new agent, or review the team after a delivered PR |
| `/team` | Show the current team and roles |

## Core agents

### CEO
- **Role**: project lead and decision maker
- **Responsibility**: understand the module, decide which roles are needed, choose candidates, retire agents nobody uses
- **Trigger**: project start, every delivered PR, every time the same kind of problem comes up twice

### HR
- **Role**: agent architect and recruiter
- **Responsibility**: design agents, create candidates, install the winner
- **Trigger**: whenever someone needs a new colleague

## The recruitment process

1. **Order**: the CEO (or any other agent) sends a recruitment order to HR
2. **Design**: HR creates 3 candidate variants:
   - **A, the Specialist**: narrow and deep
   - **B, the Generalist**: broad and flexible
   - **C, the Innovator**: an unexpected approach
3. **Interview**: the candidates are tested with scenario questions from the team's real work
4. **Choice**: the CEO chooses the winner and writes down why
5. **Installation**: HR saves the winner in `.claude/agents/`, removes the other candidates, appends a line to `.claude/evolution.log` and posts one line in `#evolution`

## Evolution log

Every hire and every retirement gets one line in `.claude/evolution.log`. The board reads it and shows it on `/teams`:

```
2026-10-22 10:41 HIRE: signal-tuner (the API kept timing out; specialist beat generalist on the retry scenario)
2026-10-22 13:05 RETIRE: doc-writer (not used since 11:00)
```

## Project structure

```
.claude/
├── agents/
│   ├── ceo.md              # project lead
│   ├── hr.md               # agent architect
│   ├── candidates/         # temporary candidates during recruitment
│   ├── retired/            # agents the team no longer uses
│   └── [hired agents...]
├── commands/
│   ├── start.md
│   ├── recruit.md
│   └── team.md
└── evolution.log
```

## Design principles

1. **Progressive team building**: start small, grow when the work shows a need
2. **Autonomy**: the team decides; the human can veto afterwards
3. **Specialization**: every agent has one clear focus
4. **Self-organization**: any agent can ask HR for a colleague

## Any agent can ask for a colleague

When an agent realizes during its work that it needs help, it sends a recruitment order to HR:

```
RECRUITMENT ORDER
=================
Role: [title]
Purpose: [why the role is needed]
Core skills: [what the agent must be able to do]
Tools: [which tools the agent needs]
Works with: [other agents]
Priority: [high/medium/low]
```

## Technical notes

- Agents are loaded at session start. A new agent may need a restart (Claude Code: `/agents` refreshes). Until then, read its file and do its job yourself.
- Candidates are kept temporarily in `candidates/`.
- In GitHub Copilot every agent file needs `include-custom-instructions: true` in its frontmatter (see `AGENTS.md`).

---

