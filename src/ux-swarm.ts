/**
 * Recipe: UX swarm.
 *
 * Audits a website's UX in parallel. A coordinator managed agent decomposes the
 * site into distinct pages/flows and delegates each to a browser-operator
 * subagent, each driving its OWN Notte cloud browser session, then synthesizes
 * their findings into one prioritized UX report.
 *
 * Pure TypeScript: it opens ONE cloud session (against the coordinator) and
 * streams it; the parallel subagents live inside that single session as threads.
 * The coordinator + worker agents are created on first run.
 *
 * Requires `npm run setup` first, plus ANTHROPIC_API_KEY + NOTTE_API_KEY.
 * Run with: npm run ux-swarm -- <url>
 */
import {
  OPERATOR_TIMEBOX_MIN,
  coordinatorAgentParams,
  findOrCreateAgent,
  loadResources,
  runManagedAgent,
  workerAgentParams,
} from "./config";

const url = process.argv[2];
if (!url) {
  console.error("Usage: npm run ux-swarm -- <url>");
  console.error("Example: npm run ux-swarm -- https://example.com");
  process.exit(1);
}

const prompt = `Run a parallel UX audit of ${url}.

1. Recon the site YOURSELF with a Notte browser session (NOT web_fetch, which you
   do not have - the site is likely JS-rendered anyway). Use
   \`notte sessions start --headless -o json\`, \`notte page goto\`, then
   \`notte page observe -o json\` to read the RENDERED links and nav. ENUMERATE the
   individual pages: landing, pricing, docs home, sign-up, log-in, key
   product/feature pages, blog, changelog, and so on. Produce a concrete list of
   page URLs to audit, then stop your recon session. (Do recon with one session
   yourself; do not spend a subagent on it.)
2. Hand EACH page to its OWN browser-operator subagent - exactly ONE page per
   operator (do not give any operator more than one page) - and run them ALL in
   PARALLEL. Brief each one to start its own Notte session and audit that single
   page using a COMBINATION of \`notte page observe\`, \`notte page scrape
   --instructions ...\`, and \`notte page screenshot\`, reporting concrete UX
   findings with evidence: what works, what is confusing or broken, slow loads,
   layout/contrast issues, dead links. Give each operator a HARD
   ${OPERATOR_TIMEBOX_MIN}-minute timebox: it must return its best, well-cited
   findings within ${OPERATOR_TIMEBOX_MIN} minutes even if partial, so one slow
   page cannot stall the whole audit. Remind each operator to pass
   --session-id explicitly on every call and to stop its own session when done.
3. When every operator has reported, synthesize a single PRIORITIZED UX REPORT:
   issues ranked by severity, each tagged with its page and supporting evidence,
   followed by the top recommendations.

Never print NOTTE_API_KEY - it is an opaque placeholder.`;

// This recipe needs a coordinator + one browser-operator worker, named for the
// recipe (so they are never shared with another recipe). Find-or-create-or-update.
async function main() {
  const { skillId } = await loadResources();
  const workerId = await findOrCreateAgent(workerAgentParams("ux-swarm-worker", skillId));
  const coordinatorId = await findOrCreateAgent(
    coordinatorAgentParams("ux-swarm-coordinator", workerId, skillId),
  );
  await runManagedAgent({
    agentId: coordinatorId,
    task: prompt,
    title: `UX swarm: ${url}`,
  });
}

main().then(
  () => console.error("\nux-swarm finished."),
  (err) => {
    console.error("\nux-swarm failed:", err);
    process.exitCode = 1;
  },
);
