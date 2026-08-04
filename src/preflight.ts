/**
 * Preflight: prove the sandbox wiring end to end before running a recipe.
 *
 * Runs ONE single-agent session that walks the integration stage by stage and
 * emits machine-readable markers, then reports a PASS/FAIL table. Use it after
 * `npm run setup`, and any time a recipe misbehaves, to tell "my prompt is wrong"
 * apart from "the plumbing is broken".
 *
 * Run with: npm run preflight
 */
import {
  BROWSER_ONLY_TOOLS,
  PATH_FIX,
  client,
  deleteSession,
  findOrCreateAgent,
  loadResources,
  runSession,
  COOKBOOK_TAG,
  WORKER_MODEL,
} from "./config";

const STAGES = [
  ["CLI_PRESENT", "notte binary resolvable on PATH after the GOROOT fix"],
  ["CLI_RUNS", "notte executes and prints help"],
  ["KEY_INJECTED", "NOTTE_API_KEY present in the sandbox env"],
  ["AUTH_STATUS", "notte auth status reports an authenticated key"],
  ["API_REACHABLE", "api.notte.cc answers (not a 503 egress failure)"],
  ["BROWSER_SESSION", "notte sessions start returns a live session id"],
] as const;

const SYSTEM = `You are a diagnostic shell operator verifying a sandbox integration. Run EXACTLY the commands you are given, in order, and report their raw output.

NOTTE_API_KEY is an opaque placeholder, never the real secret. NEVER print its value. To check that it is set, print only its LENGTH (\${#NOTTE_API_KEY}).

Do NOT try to fix, install, or work around anything. Your only job is to report what happened truthfully. A failing stage is a valid, useful result.

For each stage you MUST emit exactly one line of the form:
STAGE:<NAME>=PASS or STAGE:<NAME>=FAIL
followed by a short EVIDENCE: line quoting the decisive output.`;

const TASK = `Verify this sandbox stage by stage. Prefix every notte command with:
  ${PATH_FIX};

Stage CLI_PRESENT: run \`${PATH_FIX}; command -v notte\`. PASS if it prints a path.
Stage CLI_RUNS: run \`${PATH_FIX}; notte --help 2>&1 | head -5\`. PASS if help text appears.
Stage KEY_INJECTED: run \`echo "len=\${#NOTTE_API_KEY}"\`. PASS if len is greater than 0. Never print the value itself.
Stage AUTH_STATUS: run \`${PATH_FIX}; notte auth status 2>&1\`. PASS if it reports authenticated.
Stage API_REACHABLE: run \`${PATH_FIX}; notte sessions list -o json 2>&1 | head -c 500\`. PASS only if you get real JSON data or a normal API error. FAIL if you get HTTP 503 or any message containing "upstream connect error" or "TLS_error" or "TLSV1_ALERT_PROTOCOL_VERSION".
Stage BROWSER_SESSION: run \`${PATH_FIX}; notte sessions start --headless -o json 2>&1 | head -c 500\`. PASS only if a session id comes back. If it succeeds, immediately stop it with \`notte sessions stop\` (pass --session-id if you have the id).

After all six stages, print a final block:
SUMMARY
one STAGE:<NAME>=PASS/FAIL line per stage, all six, in order.`;

async function main() {
  const res = await loadResources();

  const agentId = await findOrCreateAgent({
    name: "notte-preflight",
    model: WORKER_MODEL,
    system: SYSTEM,
    tools: BROWSER_ONLY_TOOLS,
    skills: res.skillId ? [{ type: "custom", skill_id: res.skillId }] : undefined,
    metadata: { managed_by: COOKBOOK_TAG },
  });

  const session = await client.beta.sessions.create({
    agent: agentId,
    environment_id: res.environmentId,
    vault_ids: [res.vaultId],
    title: "notte preflight",
  });
  console.error(`Session: ${session.id}`);
  console.error(
    `Watch:   https://platform.claude.com/workspaces/default/sessions/${session.id}\n`,
  );

  let transcript = "";
  try {
    transcript = await runSession(session.id, TASK);
  } finally {
    await deleteSession(session.id);
  }

  // Parse the LAST verdict per stage, so the SUMMARY block wins over any
  // earlier provisional line for the same stage.
  const verdicts = new Map<string, string>();
  for (const m of transcript.matchAll(/STAGE:([A-Z_]+)\s*=\s*(PASS|FAIL)/g)) {
    verdicts.set(m[1], m[2]);
  }

  console.log("\n\n=== PREFLIGHT RESULT ===");
  let failed: string[] = [];
  for (const [name, desc] of STAGES) {
    const v = verdicts.get(name) ?? "UNKNOWN";
    if (v !== "PASS") failed.push(name);
    const icon = v === "PASS" ? "PASS" : v === "FAIL" ? "FAIL" : "????";
    console.log(`[${icon}] ${name.padEnd(16)} ${desc}`);
  }

  const tlsSignature =
    /TLSV1_ALERT_PROTOCOL_VERSION|upstream connect error|TLS_error/i.test(transcript);

  if (failed.length === 0) {
    console.log("\nAll stages passed. The integration is live; run a recipe.");
    return;
  }

  console.log(`\n${failed.length} stage(s) not passing: ${failed.join(", ")}`);

  if (tlsSignature && (failed.includes("API_REACHABLE") || failed.includes("BROWSER_SESSION"))) {
    console.log(
      `
DIAGNOSIS: TLS minimum version mismatch, not a bug in this cookbook.

  The sandbox egress proxy negotiates TLS 1.2 to upstream hosts. If the API's
  edge requires a 1.3 minimum, the handshake is refused before any HTTP is
  exchanged and every call comes back as HTTP 503 with
  TLSV1_ALERT_PROTOCOL_VERSION. The CLI, the vault injection, and the agent
  orchestration are all fine; only the upstream handshake fails.

  Check the minimum TLS version on the CDN or load balancer in front of the
  API and allow 1.2. TLS 1.3 stays available and is still what clients
  negotiate by default. Confirm from your machine with:

    openssl s_client -connect api.notte.cc:443 -servername api.notte.cc -tls1_2

  "Cipher is (NONE)" means 1.2 is being refused. Re-run preflight once the
  edge allows it; nothing in this repo needs to change.`,
    );
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nPreflight failed:", err);
  process.exitCode = 1;
});
