# Requirements to shape the refactor

1. Pinata is a delight for users to use

- TUI updates in coordinator (main) agent thread in real time, emoji support
- Multiple color palette support. Minimal palettes: Catppuccin, Gruvbox, Tokyo Night, Rose Pine, Dracula, Nord, One Dark / One Light, Solarized, inherit pi System/terminal default

2. Parallel execution: Run agents concurrently in the background or foreground with configurable concurrency and queuing
3. Custom agents: Define prompts, models, thinking levels, tool permissions, skills, and color using Markdown and Markdown frontmatter.
4. Live monitoring: Display agent status, tool activity, token usage and context utilization. No extra overlays, seamless navigation between TUI screens using modifier keys + arrows
5. Fleet navigation: browse agents, inspect and steer their live conversations
6. Agent control: steer, stop, resume, or move supported foreground runs into the background
7. direct addressing with @handle to start, message, or resume agents
8. context and memory: optionally inherit parent conversations and retain agent scoped memory
9. Code isolation: use git worktrees with automatic commits on completion
10. Nested delegation: allow explicitly authorized agents to spawn children with depth limits
11. Scheduling: support session-scoped cron, interval, and one-shot agent runs
12. Results and notifcations: notify parent on completion and expose full results
13. Extension integration: provide lifecycle events, usage reporting, and pinata CLI support for headless runs

- Fully agent compatible (skills, schema introspection via typed zod models throughout the ecosystem, etc)
- CODEX style agent definitions

14. Pinata base engine tenants where applicable (operating modes, herdr optional support), pinata theme
15. Diataxis led documentation that prioritizes robust complex examples but simple, human readable explanations. Minimal set of examples (dont overcomplicate).
16. Full Reference API documentation.
17. Arena adapted for new v3.0.0 implementation
18. Uses this as a reference implementation but does not mention in docs or commit history, and prefers the tenants and engine pieces of pinata that operate with better performance https://github.com/tintinweb/pi-subagents/tree/master
