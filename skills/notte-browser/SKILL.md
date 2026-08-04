---
name: notte-browser
description: >
  Drive Notte (notte.cc) cloud browsers from a Claude Managed Agents sandbox:
  start and stop remote browser sessions, navigate pages, observe/click/fill
  elements, scrape structured content, and capture screenshots. Use whenever a
  task requires seeing or acting on a real rendered web page.
allowed-tools: Bash
---

# Notte browser CLI (Managed Agents sandbox)

Adapted for the Claude Managed Agents cloud sandbox from the upstream skill in
[nottelabs/notte-skills](https://github.com/nottelabs/notte-skills). The upstream
version assumes a laptop (Homebrew install, interactive `notte auth login`);
neither applies here, so follow this file instead.

## Three sandbox rules

### 1. Fix PATH before the first call

The CLI is preinstalled via the Go toolchain, which drops the binary in
`$(go env GOROOT)/bin`. That directory is **not** on the default PATH.

```bash
export PATH="$PATH:$(go env GOROOT)/bin:$(go env GOPATH)/bin"
```

Chain it into the same command whenever you are unsure of your shell state:

```bash
export PATH="$PATH:$(go env GOROOT)/bin"; notte sessions list
```

### 2. Never print NOTTE_API_KEY

`NOTTE_API_KEY` is already set and the CLI reads it automatically. Its value in
the sandbox is an **opaque placeholder**, not the real secret; the real key is
attached at the network boundary only on requests to `api.notte.cc`. Echoing,
logging, or transmitting it leaks nothing useful and is treated as a security
violation. To confirm it is set, print only its length: `echo ${#NOTTE_API_KEY}`.

### 3. Always pass `--session-id` explicitly

`notte sessions start` records a "current session" in per-container state that
**every concurrent operator in this sandbox shares**. If two subagents both rely
on it, they will drive each other's browsers. Capture your own id and pass it on
every subsequent call:

```bash
export PATH="$PATH:$(go env GOROOT)/bin"
SID=$(notte sessions start --headless -o json | python3 -c 'import sys,json;print(json.load(sys.stdin)["session_id"])')
notte page goto "https://example.com" --session-id "$SID"
notte page observe -o json --session-id "$SID"
notte sessions stop --session-id "$SID"
```

If that JSON key does not exist, print the raw JSON once and read the id from it.

## Core commands

| Command | Purpose |
|---|---|
| `notte sessions start --headless -o json` | Start a cloud browser; returns the session id |
| `notte page goto "<url>"` | Navigate. Needs a FULL url WITH scheme |
| `notte page observe -o json` | Rendered page state plus interactable element ids (`@B3`, `@I1`) |
| `notte page scrape --instructions "..."` | Structured extraction from the current page |
| `notte page click "@B3"` | Click an element by its observed id |
| `notte page fill "@I1" "text"` | Fill an input |
| `notte page screenshot` | Visual evidence |
| `notte page scroll-down` / `scroll-up` | Scroll |
| `notte page wait <seconds>` | Wait |
| `notte sessions stop` | Stop the session you started (always do this) |

Useful session flags: `--proxy-country <code>`, `--solve-captchas`,
`--viewport-width` / `--viewport-height`, `--browser-type chromium|chrome|firefox`.

## Working method

1. `goto` the target URL, then `observe` to get the rendered structure and the
   element ids you can act on. Do not guess selectors; `observe` gives you the ids.
2. Use `scrape --instructions` when you want content rather than interaction. Give
   it a precise instruction; it returns structured data, not raw HTML.
3. Use `screenshot` for anything visual (layout, contrast, overlap, broken images).
4. Combine all three. `observe` alone misses visual defects; `screenshot` alone
   misses link targets and element state.
5. `goto` requires a scheme. Normalize a bare host to `https://host` and resolve
   relative or protocol-relative links to absolute URLs before navigating.
6. Stop your session when finished, including on the error path.

## Do not

- Do not fetch pages out of band (no `curl` for page content, no `web_fetch`). The
  point is what a real browser renders.
- Do not reuse another operator's session id.
- Do not leave sessions running.
- Do not install the CLI; it is already present. If `notte` is missing, report that
  rather than trying to install it.

## Reading errors

- `503` plus `upstream connect error` / `TLSV1_ALERT_PROTOCOL_VERSION`: the sandbox
  egress proxy could not complete a TLS handshake with `api.notte.cc`. This is an
  infrastructure mismatch, not something you can fix from inside the sandbox.
  Report it and stop.
- `401` / `403`: the key was not substituted. Check that the host you called is
  `api.notte.cc`; the credential is scoped to that host only.
- `session ID required`: you relied on the shared "current session". Pass
  `--session-id` explicitly.
