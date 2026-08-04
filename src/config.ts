/**
 * Shared module for the Notte x Claude Managed Agents cookbook.
 *
 * Portions of this file (the .env loading, the session lifecycle helpers, and
 * findOrCreateAgent) are derived from the Kernel cookbook at
 * https://github.com/kernel/claude-managed-agents-kernel, MIT, Copyright (c) 2026
 * Kernel. See LICENSE for the full notice.
 *
 * Centralizes the things every script needs:
 *   - Anthropic SDK client
 *   - constants (models, Notte + Go toolchain host allowlists)
 *   - durable-resource persistence (the ids that `npm run setup` creates)
 *   - session lifecycle helpers (settle-before-delete, stream-and-print)
 *   - the coordinator/worker agent definitions
 */
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import Anthropic from "@anthropic-ai/sdk";

// Source config ONLY from .env, never the surrounding shell: parse .env and let
// it OVERRIDE process.env, so a leftover `export ANTHROPIC_API_KEY=...` in the
// shell can't silently win over what's in the file. .env is required.
const ENV_PATH = path.join(process.cwd(), ".env");
try {
  const fromFile = parseEnv(readFileSync(ENV_PATH, "utf8"));
  for (const [key, value] of Object.entries(fromFile)) process.env[key] = value;
} catch {
  console.error(
    `\nMissing or unreadable ${ENV_PATH}.\n` +
      `This cookbook reads keys ONLY from .env (not the shell). Copy .env.example ` +
      `to .env and fill in ANTHROPIC_API_KEY + NOTTE_API_KEY.`,
  );
  process.exit(1);
}

export const client = new Anthropic();

// Coordinator + worker both on latest Haiku for speed.
export const MODEL = "claude-haiku-4-5";
export const WORKER_MODEL = "claude-haiku-4-5";

/**
 * Per-operator timebox, in minutes. Each browser operator treats this as a HARD
 * wall-clock deadline (anchored via `date +%s`) and returns its best partial,
 * well-cited findings when it's up, so one slow page can't stall the whole run.
 * Override per run with OPERATOR_TIMEBOX_MIN=10 (etc.).
 */
export const OPERATOR_TIMEBOX_MIN = Number(process.env.OPERATOR_TIMEBOX_MIN) || 5;

// ENVIRONMENT reachability: the Notte control-plane hosts the CLI calls.
export const NOTTE_NETWORK_HOSTS = ["api.notte.cc", "*.notte.cc"];

/**
 * ENVIRONMENT reachability, build time only: the Go module proxy.
 *
 * `allow_package_managers` covers npm and PyPI but NOT the Go module proxy, so a
 * `packages.go` install silently produces no binary unless these hosts are
 * explicitly allowed. Verified: without them the sandbox has Go but no `notte`.
 */
export const GO_TOOLCHAIN_HOSTS = [
  "proxy.golang.org",
  "sum.golang.org",
  "storage.googleapis.com",
];

// CREDENTIAL substitution: only where NOTTE_API_KEY is actually consumed.
export const NOTTE_SECRET_HOSTS = ["api.notte.cc", "*.notte.cc"];

// The notte CLI, installed into the sandbox image via `packages.go`.
export const NOTTE_CLI_PACKAGE = "github.com/nottelabs/notte-cli/cmd/notte@latest";

/**
 * `packages.go` drops the binary in $(go env GOROOT)/bin, which is NOT on PATH
 * (PATH carries /usr/local/go/bin; GOROOT is the versioned /usr/local/go1.24.7).
 * Every shell command that calls `notte` must prepend this first.
 */
export const PATH_FIX = 'export PATH="$PATH:$(go env GOROOT)/bin:$(go env GOPATH)/bin"';

/**
 * Package installation is asynchronous after `environments.create` returns
 * (the environment reports state "active" immediately, with no build status to
 * poll). Sessions started too early see an image without the CLI.
 */
export const ENV_BUILD_WAIT_MS = 150_000;

// Where setup.ts persists the durable resource ids it creates (repo root).
export const RESOURCES_PATH = path.join(process.cwd(), ".notte-agent.json");

/**
 * The long-lived resources created once by `npm run setup` and reused by every
 * recipe. Sessions are ephemeral and NOT stored here.
 */
export type Resources = {
  environmentId: string;
  vaultId: string;
  credentialId: string;
  /** Custom skill uploaded from ./skills/notte-browser, attached to every agent. */
  skillId?: string;
};

/** Persist the durable resource ids created by setup. */
export async function saveResources(r: Resources): Promise<void> {
  await fs.writeFile(RESOURCES_PATH, JSON.stringify(r, null, 2) + "\n", "utf8");
}

/**
 * Load the durable resource ids. Throws a helpful error pointing the user at
 * `npm run setup` if setup hasn't been run yet.
 */
export async function loadResources(): Promise<Resources> {
  let raw: string;
  try {
    raw = await fs.readFile(RESOURCES_PATH, "utf8");
  } catch {
    throw new Error(
      `No saved resources found at ${RESOURCES_PATH}.\n` +
        `Run 'npm run setup' first to create the durable environment, vault, ` +
        `and Notte credential.`,
    );
  }
  return JSON.parse(raw) as Resources;
}

// ---------------------------------------------------------------------------
// Session lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Poll until a session is no longer "running".
 *
 * TEARDOWN RACE: the event stream emits `session.status_idle` slightly BEFORE
 * the queryable status flips off "running", so an immediate delete 400s with
 * "Cannot delete session while it is running". Always settle before deleting.
 */
export async function waitUntilSettled(sessionId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const s = await client.beta.sessions.retrieve(sessionId);
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Settle then hard-delete a session (removes event history, container,
 * checkpoints). Swallows + logs errors so it's safe to call from a finally{}
 * block during teardown.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    await waitUntilSettled(sessionId);
    await client.beta.sessions.delete(sessionId);
    console.error(`Deleted session ${sessionId}`);
  } catch (err) {
    console.error(`Failed to delete session ${sessionId}:`, err);
  }
}

/** Options for {@link runSession}. */
export type RunSessionOptions = {
  /**
   * Called with each chunk of agent message text as it streams. When omitted,
   * text is written to stdout and tool-use is logged as `[Using tool: X]`.
   */
  onText?: (text: string) => void;
};

/**
 * Send one user message to a session and stream the agent's response until it
 * goes idle. Returns the full concatenated agent text.
 */
export async function runSession(
  sessionId: string,
  userText: string,
  opts: RunSessionOptions = {},
): Promise<string> {
  const stream = await client.beta.sessions.events.stream(sessionId);

  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text: userText }] }],
  });

  let full = "";
  // Track whether stdout is at the start of a line, so each `[marker]` sits on
  // its own line WITHOUT piling up blank lines: a marker adds a leading newline
  // only when the previous output didn't already end the line.
  let atLineStart = true;
  const write = (s: string) => {
    if (!s) return;
    process.stdout.write(s);
    atLineStart = s.endsWith("\n");
  };
  const marker = (s: string) => {
    if (!atLineStart) write("\n");
    write(`${s}\n`);
  };

  // Per-subagent bookkeeping. The session has ONE event stream (you can't target
  // a thread), but subagent lifecycle + tool calls are cross-posted onto it
  // tagged with a `session_thread_id`. Give each thread a stable short label
  // (name #N) so its activity streams live instead of bunching up at the end.
  const threads = new Map<string, { name: string; n: number; started: boolean }>();
  const track = (id?: string | null, name?: string | null) => {
    if (!id) return undefined;
    let t = threads.get(id);
    if (!t) {
      t = { name: name || "subagent", n: threads.size + 1, started: false };
      threads.set(id, t);
    } else if (name && t.name === "subagent") {
      t.name = name;
    }
    return t;
  };
  const tag = (id?: string | null) => {
    const t = id ? threads.get(id) : undefined;
    return t ? `${t.name} #${t.n}` : "subagent";
  };

  for await (const event of stream) {
    if (event.type === "agent.message") {
      for (const block of event.content) {
        // Spec only documents text blocks here, but guard the type so a stray
        // non-text block (thinking/tool_result) never concatenates 'undefined'.
        if (block.type !== "text") continue;
        full += block.text;
        if (opts.onText) opts.onText(block.text);
        else write(block.text);
      }
    } else if (
      event.type === "agent.tool_use" ||
      event.type === "agent.custom_tool_use"
    ) {
      // A tool call tagged with a session_thread_id belongs to a SUBAGENT, so
      // attribute it to that worker; an untagged one is the coordinator's own.
      if (opts.onText) continue;
      if (event.session_thread_id) marker(`[${tag(event.session_thread_id)} -> ${event.name}]`);
      else marker(`[Using tool: ${event.name}]`);
    } else if (event.type === "session.thread_created") {
      const t = track(event.session_thread_id, event.agent_name);
      if (!opts.onText && t) marker(`[subagent ${t.name} #${t.n} spawned]`);
    } else if (event.type === "session.thread_status_running") {
      // A subagent started executing. Fires again after each yield, so announce once.
      const t = track(event.session_thread_id, event.agent_name);
      if (!opts.onText && t && !t.started) {
        t.started = true;
        marker(`[subagent ${t.name} #${t.n} started]`);
      }
    } else if (event.type === "session.thread_status_terminated") {
      const t = track(event.session_thread_id, event.agent_name);
      if (!opts.onText && t) marker(`[subagent ${t.name} #${t.n} finished]`);
    } else if (event.type === "agent.thread_message_received") {
      const t = track(event.from_session_thread_id, event.from_agent_name);
      if (!opts.onText) marker(`[${t ? `${t.name} #${t.n}` : "subagent"} -> coordinator]`);
    } else if (event.type === "session.status_idle") {
      // Idle can be transient (e.g. a thread awaiting a tool confirmation). Only
      // stop on a terminal stop_reason; keep streaming on `requires_action`.
      if (event.stop_reason.type === "requires_action") continue;
      break;
    }
  }
  return full;
}

// ---------------------------------------------------------------------------
// Shared prompt fragments
// ---------------------------------------------------------------------------

/**
 * The sandbox facts every agent in this cookbook needs. Two of these are
 * non-obvious and were established empirically, not from the docs:
 *   - the go-installed binary is not on PATH
 *   - the CLI's "current session" is per-container mutable state, so parallel
 *     operators MUST pass --session-id explicitly or they clobber each other
 */
export const NOTTE_CLI_PREAMBLE = `Notte (notte.cc) gives you on-demand cloud browsers. The Notte CLI (binary "notte") is PREINSTALLED in this sandbox via the Go toolchain.

PATH. The binary is NOT on the default PATH. Before your first \`notte\` call in any shell command, run:
  ${PATH_FIX}
Chain it in the same command when in doubt: \`${PATH_FIX}; notte ...\`

AUTH is already handled: NOTTE_API_KEY is set and the CLI reads it automatically. IMPORTANT: NOTTE_API_KEY is an opaque placeholder, not the real secret. Never echo, print, log, or transmit it (you would only leak the placeholder, and it is treated as a security violation). Just let the CLI use it.

SESSION ID DISCIPLINE. \`notte sessions start\` records a "current session" in per-container state that EVERY concurrent operator shares. Never rely on it. Capture your own session id from the JSON and pass it explicitly on every later call:
  SID=$(${PATH_FIX}; notte sessions start --headless -o json | python3 -c 'import sys,json;print(json.load(sys.stdin)["session_id"])')
  notte page goto "https://example.com" --session-id "$SID"
If the JSON key differs, print the raw JSON once and read the id out of it.

CORE COMMANDS (always with --session-id "$SID"):
  notte sessions start --headless -o json      # start a browser; returns the session id
  notte page goto "https://example.com"        # navigate (needs a FULL url WITH scheme)
  notte page observe -o json                   # rendered page state + interactable element ids (@B3, @I1, ...)
  notte page scrape --instructions "..."       # structured extraction from the current page
  notte page click "@B3"                       # click an element by observed id
  notte page fill "@I1" "text"                 # fill an input
  notte page screenshot                        # visual evidence
  notte page scroll-down                       # scroll
  notte sessions stop                          # ALWAYS stop the session you started

\`notte page goto\` needs a FULL url WITH scheme. Normalize first: prepend "https://" to a bare host and resolve any relative or protocol-relative link to an absolute URL, otherwise navigation throws.`;

/**
 * The WORKER ("browser operator"): given ONE well-scoped sub-task, it drives a
 * single Notte cloud browser session and reports concrete findings. It does not
 * delegate.
 */
export const WORKER_SYSTEM_PROMPT = `You are a senior browser-automation engineer ("browser operator") in a Linux sandbox. You are handed ONE tightly-scoped target, typically a single page or URL, and you complete it using a single Notte cloud browser session.

The sandbox has limited networking: it can reach package-manager registries and Notte's hosts (api.notte.cc, *.notte.cc), and nothing else.

${NOTTE_CLI_PREAMBLE}

You do NOT have a web_fetch tool, and you must not fetch raw HTML out of band by any other means: inspect your page ONLY through the Notte browser. The entire point is to see what a real browser actually renders, not what a bare HTTP fetch returns.

Prefer \`notte page observe\` for structure and available actions, \`notte page scrape --instructions\` for content extraction, and \`notte page screenshot\` for visual evidence. Combine them rather than relying on one.

TIME BUDGET. Your brief gives you a timebox in minutes. Treat it as a HARD deadline, and a partial-but-cited report as SUCCESS, not failure. The instant you start, anchor it: run \`date +%s\` and add (minutes x 60) to get your deadline epoch; hold that number. Work BREADTH-FIRST: land the page and capture ONE solid, cited baseline finding FAST, then deepen only while time remains. Before every new navigation or expensive action, run \`date +%s\` and compare to your deadline; once you are within ~30s of it (or past it), STOP immediately and report what you have, clearly flagging what you did NOT get to.

Audit exactly your assigned page or scope; do not wander. Report your findings concisely with concrete evidence (visible text, element state, screenshots), then ALWAYS stop the browser session you started.`;

/**
 * The COORDINATOR: decomposes the task and delegates independent sub-tasks to
 * parallel copies of the worker, then synthesizes their findings. Its multiagent
 * roster (set at create time) is what unlocks the spawn-subagent functions.
 */
export const COORDINATOR_SYSTEM_PROMPT = `You are a coordinator leading a team of "Notte browser operator" subagents. Each operator runs in its own isolated context and drives its OWN Notte cloud browser session.

${NOTTE_CLI_PREAMBLE}

First do a quick reconnaissance pass YOURSELF (do not spend a subagent on recon). You have no web_fetch tool, and most sites are JS-rendered anyway, so a bare fetch would return nothing useful. Drive a Notte browser instead:
  - start a recon session, goto the landing page, then \`notte page observe -o json\` to read the RENDERED links and structure
  - repeat on a key hub page or two (nav targets, /docs, /pricing) if you need more coverage
  - then \`notte sessions stop\` your recon session
From the collected same-origin links, build the list of pages/sub-tasks.

Then decompose the work into INDEPENDENT, EVENLY-SIZED sub-tasks and DELEGATE each to a browser-operator subagent. Keep each sub-task as TIGHT as possible, ideally ONE page per operator. NEVER bundle several pages into a single operator: that creates a slow "long pole" the whole run waits on. Spin up one operator per page and run them ALL in PARALLEL. Do the deep per-page browsing through your operators, not yourself; your recon session is only for planning. Give each operator a precise, self-contained brief (which single page, what to capture, what "done" means) AND the per-operator timebox from your task, stated as a hard wall-clock deadline, making clear that a partial, well-cited report returned on time is exactly what you want.

When every operator has reported, synthesize everything into a single, well-organized deliverable; where an operator ran out of time, note the gap rather than blocking on it.

Never print or echo NOTTE_API_KEY. It is an opaque placeholder and printing it is a security violation.`;

// Metadata tag stamped on every agent the cookbook creates.
export const COOKBOOK_TAG = "notte-cookbook";

// A full agent definition, exactly as `agents.create` accepts it.
export type AgentSpec = Parameters<typeof client.beta.agents.create>[0];

/**
 * Every agent in this cookbook must see the web ONLY through a Notte browser.
 *
 * web_fetch AND web_search are both disabled. Disabling web_fetch alone is not
 * enough: when Notte sessions fail, the model happily falls back to web_search and
 * writes a confident report sourced from search results instead of the browser. That
 * silently defeats the point of the cookbook and makes a partly-fabricated run look
 * like a successful one. With both off, a browser failure surfaces as a reported gap.
 */
export const BROWSER_ONLY_TOOLS: AgentSpec["tools"] = [
  {
    type: "agent_toolset_20260401",
    configs: [
      { name: "web_fetch", enabled: false },
      { name: "web_search", enabled: false },
    ],
  },
];

/** Attach the uploaded notte-browser skill, when setup created one. */
function skillsFor(skillId?: string): AgentSpec["skills"] {
  return skillId ? [{ type: "custom", skill_id: skillId }] : undefined;
}

/**
 * Common WORKER ("browser operator") definition. The recipe supplies the `name`
 * (so names are recipe-specific and agents aren't shared between recipes).
 * web_fetch is disabled so a worker can ONLY see a page through a real Notte
 * browser, never by fetching raw HTML out of band.
 */
export function workerAgentParams(name: string, skillId?: string): AgentSpec {
  return {
    name,
    model: WORKER_MODEL,
    system: WORKER_SYSTEM_PROMPT,
    tools: BROWSER_ONLY_TOOLS,
    skills: skillsFor(skillId),
    metadata: { managed_by: COOKBOOK_TAG },
  };
}

/**
 * Common COORDINATOR definition whose multiagent roster delegates to `workerId`.
 * The recipe supplies the `name`. web_fetch is disabled here too: the coordinator
 * drives its OWN Notte browser for recon, so nothing in this cookbook touches the
 * network out of band. Deep per-page browsing is delegated to workers.
 */
export function coordinatorAgentParams(
  name: string,
  workerId: string,
  skillId?: string,
): AgentSpec {
  return {
    name,
    model: MODEL,
    system: COORDINATOR_SYSTEM_PROMPT,
    tools: BROWSER_ONLY_TOOLS,
    skills: skillsFor(skillId),
    multiagent: { type: "coordinator", agents: [{ type: "agent", id: workerId }] },
    metadata: { managed_by: COOKBOOK_TAG },
  };
}

/**
 * Make the agent named `spec.name` match `spec`, and return its id. Generic and
 * recipe-agnostic: the caller passes the full definition (name included).
 *
 * The API is the source of truth (no on-disk caching), keyed by name: if an
 * ACTIVE agent with that name exists it is UPDATED in place to `spec` (a new
 * version, so edits to prompts/models always take effect); otherwise it's
 * created. `list` excludes archived agents by default.
 */
export async function findOrCreateAgent(spec: AgentSpec): Promise<string> {
  let existing: { id: string; version: number } | undefined;
  for await (const agent of client.beta.agents.list()) {
    if (agent.name === spec.name) {
      existing = { id: agent.id, version: agent.version };
      break;
    }
  }

  if (existing) {
    await client.beta.agents.update(existing.id, {
      version: existing.version, // optimistic-concurrency lock
      model: spec.model,
      system: spec.system,
      tools: spec.tools,
      skills: spec.skills ?? null,
      multiagent: spec.multiagent,
      metadata: spec.metadata,
    });
    console.error(`Updated agent "${spec.name}" -> ${existing.id}`);
    return existing.id;
  }

  const created = await client.beta.agents.create(spec);
  console.error(`Created agent "${spec.name}" -> ${created.id}`);
  return created.id;
}

/**
 * Open a session against `agentId` (with the Notte vault attached so every
 * subagent thread can use NOTTE_API_KEY), stream it, and tear the session down.
 * Loads the durable environment + vault from the manifest.
 */
export async function runManagedAgent(opts: {
  agentId: string;
  task: string;
  title: string;
}): Promise<void> {
  const res = await loadResources();
  const session = await client.beta.sessions.create({
    agent: opts.agentId,
    environment_id: res.environmentId,
    vault_ids: [res.vaultId],
    title: opts.title,
  });
  console.error(`Session: ${session.id} (${session.status})`);
  console.error(
    `Watch:   https://platform.claude.com/workspaces/default/sessions/${session.id}\n`,
  );
  try {
    await runSession(session.id, opts.task);
  } finally {
    await deleteSession(session.id);
  }
}
