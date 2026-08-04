# Claude Managed Agents + Notte browsers

Give a Claude Managed Agent a real browser. Recipes for running swarms of
[Notte](https://notte.cc) cloud browsers from Anthropic's hosted agent platform, with
your API key held in a vault and never exposed to the model.

## What's here

| | |
|---|---|
| `src/preflight.ts` | Checks the whole integration stage by stage. Run it first. |
| `src/ux-swarm.ts` | Audits a site's UX. One browser per page, all in parallel. |
| `src/lead-intel.ts` | Researches a lead: product, pricing, metering, customers, momentum, hiring. One angle per subagent. |
| `skills/notte-browser/` | A [notte-skills](https://github.com/nottelabs/notte-skills) skill adapted for the sandbox, uploaded and attached to every agent. |

You need Node 22+, an `ANTHROPIC_API_KEY` with Managed Agents access, and a
`NOTTE_API_KEY` from [console.notte.cc](https://console.notte.cc/apikeys).

## Run it

```bash
npm install
cp .env.example .env    # fill in both keys
npm run setup           # one time; ends with a 150s wait for the image build
npm run preflight       # confirm the plumbing before blaming your prompt
npm run ux-swarm   -- https://example.com
npm run lead-intel -- https://acme.com
npm run teardown
```

`setup` creates the durable pieces and writes their ids to `.notte-agent.json`: a
cloud environment with the notte CLI installed, a vault holding `NOTTE_API_KEY`, and
the uploaded skill. Every recipe reuses them. `teardown` deletes all of it and
archives the agents, since agents have no delete.

`preflight` prints a table and tells you which layer is broken:

```
[PASS] CLI_PRESENT      notte binary resolvable on PATH after the GOROOT fix
[PASS] CLI_RUNS         notte executes and prints help
[PASS] KEY_INJECTED     NOTTE_API_KEY present in the sandbox env
[PASS] AUTH_STATUS      notte auth status reports an authenticated key
[PASS] API_REACHABLE    api.notte.cc answers (not a 503 egress failure)
[PASS] BROWSER_SESSION  notte sessions start returns a live session id
```

## Two networking planes

They are easy to confuse and do different jobs.

Environment networking is a firewall on the container, set in `setup.ts`:

```ts
networking = {
  type: "limited",
  allow_package_managers: true,   // npm + PyPI only
  allow_mcp_servers: false,
  allowed_hosts: [
    "api.notte.cc", "*.notte.cc",
    "proxy.golang.org", "sum.golang.org", "storage.googleapis.com",
  ],
}
```

Those last three are the ones people miss. `allow_package_managers` covers npm and
PyPI but not the Go module proxy, so without them the `packages.go` install quietly
produces nothing and you get a sandbox with a Go toolchain and no `notte`.

Credential networking is set on the credential itself and governs substitution, not
reachability:

```ts
auth.networking = { type: "limited", allowed_hosts: ["api.notte.cc", "*.notte.cc"] }
```

`NOTTE_API_KEY` inside the sandbox is an opaque placeholder. The real key is spliced
in at the network boundary, only on requests to an allowed host. It never lands in
the container, never enters the model's context, and is never logged. Keep the list
tight: it is the only thing between a prompt-injected agent and your key.

## Browser-only by construction

Every agent has `web_fetch` and `web_search` both disabled.

Disabling only `web_fetch` is not enough. If browser sessions fail mid-run, an agent
with search still available will fall back to it and write a confident, well-cited
report where some sections never came from a browser, with nothing marking which.
A partly synthesized run then looks identical to a clean one. With both off, a
browser failure can only show up as a reported gap, which is what the recipes ask
for. Keep both disabled if you fork these.

## Three things that will waste your afternoon

None of these are in the docs. All were found the hard way.

1. The go-installed binary is not on PATH. `packages.go` drops it in
   `$(go env GOROOT)/bin`, a versioned path like `/usr/local/go1.24.7`, while PATH
   carries `/usr/local/go/bin`. Every prompt here prepends
   `export PATH="$PATH:$(go env GOROOT)/bin:$(go env GOPATH)/bin"`.
2. Package install is asynchronous. `environments.create` returns `state: "active"`
   with no build status to poll, but the image is not ready and a session started
   right away sees no CLI. `setup.ts` waits 150s.
3. `notte sessions start` records a "current session" in per-container state that
   every concurrent subagent shares, so parallel operators will drive each other's
   browsers. Each operator captures its own id and passes `--session-id` on every
   call.

## Troubleshooting

A 503 carrying `TLSV1_ALERT_PROTOCOL_VERSION` means the sandbox egress proxy could
not complete a TLS handshake with the upstream host. It negotiates TLS 1.2, so an
edge configured to require 1.3 will refuse it before any HTTP happens. Check your
CDN's minimum TLS version first. `preflight.ts` detects this signature and says so.

If `BROWSER_SESSION` is the only failing stage, re-run it. Transient 503s from
session start are worth a retry before digging. Because a swarm opens one browser per
page, a few operators may lose their session on a large site and report a gap instead
of findings.

## On notte-mcp

Notte serves an MCP endpoint at `https://api.notte.cc/mcp/`, and Managed Agents can
attach URL-based MCP servers. This cookbook does not use it. Anthropic's URL MCP
server definition is `{ name, type, url }` with nowhere to put an authorization
header, and Notte's MCP wants OAuth or a bearer token, so there is no headless way to
authenticate it from a managed session today. The CLI plus a vault credential is the
supported path. Worth revisiting if either side gains the missing piece.
