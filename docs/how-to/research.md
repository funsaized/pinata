# Enable research

Use a researcher when a task needs external documentation or other web sources.
Copy the optional [researcher definition](../../examples/agents/researcher.md) into
your agent directory using [creating agents](agents.md), then select it with
`agent: "researcher"`.

Research agents search the web through [pi-web-access](https://github.com/nicobailon/pi-web-access).
Install it in Pi (_manual_):

```sh
pi install git:github.com/nicobailon/pi-web-access
```

Reload Pi. Pinata finds pi-web-access through the tools Pi loaded and gives research agents
its `web_enable`, `web_search`, `fetch_content` and `get_search_content` tools. If it is
installed somewhere Pi does not load it from, set `webExtension` to its entry file in
[configuration](../reference/config.md). Without it, runs with research tasks are refused
with these instructions. Research tools use the same provider resolution as other
custom agent tools. See the [research assignments](../../examples/README.md#researcher-answer-a-question-from-sources)
for prompts you can adapt.
