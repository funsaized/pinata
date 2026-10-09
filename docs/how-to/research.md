# Enable research

Research agents search the web through [pi-web-access](https://github.com/nicobailon/pi-web-access).
Install it in Pi (_manual_):

```sh
pi install git:github.com/nicobailon/pi-web-access
```

Reload Pi. pinata finds pi-web-access through the tools Pi loaded and gives research agents
its `web_enable`, `web_search`, `fetch_content` and `get_search_content` tools. If it is
installed somewhere Pi does not load it from, set `webExtension` to its entry file in
[configuration](../reference/config.md). Without it, runs with research tasks are refused
with these instructions.
