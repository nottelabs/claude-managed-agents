# Example output

## `npm run preflight`

```
=== PREFLIGHT RESULT ===
[PASS] CLI_PRESENT      notte binary resolvable on PATH after the GOROOT fix
[PASS] CLI_RUNS         notte executes and prints help
[PASS] KEY_INJECTED     NOTTE_API_KEY present in the sandbox env
[PASS] AUTH_STATUS      notte auth status reports an authenticated key
[PASS] API_REACHABLE    api.notte.cc answers (not a 503 egress failure)
[PASS] BROWSER_SESSION  notte sessions start returns a live session id

All stages passed. The integration is live; run a recipe.
```

Six green stages mean the CLI installed and resolves on PATH, the vault credential
reached the sandbox as `NOTTE_API_KEY`, the API is reachable through the egress
proxy, and a real cloud browser starts from inside the sandbox. Anything red points
at one layer, so you are not guessing which.

## `npm run ux-swarm -- https://notte.cc`

With `OPERATOR_TIMEBOX_MIN=3`:

- the coordinator ran recon in its own browser and enumerated the site's pages
- it spawned one operator per page, each driving its own session in parallel
- operators reported findings with evidence: a glossary with no search across 56
  terms, a sign-in page with no route to sign up, dropdown triggers with no affordance
- the coordinator merged everything into one report ranked by severity, citing the
  page behind each finding

Pages whose sessions dropped were listed as gaps rather than filled in from
elsewhere. That behaviour is the point, and it is why `web_search` is disabled. A
report that admits what it missed is worth more than one that quietly papers over it.

## `npm run lead-intel -- https://resend.com`

Same shape, different decomposition: one subagent per research angle instead of one
per page. Returns a brief covering what the company sells, pricing tiers and how
usage is metered, named customers pulled off the site, recent changelog and blog
activity, and open roles with the stack named in the postings. Every claim cites the
page it came from.
