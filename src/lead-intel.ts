/**
 * Recipe: lead intel.
 *
 * Takes a customer lead's site, decomposes it into parallelizable research tasks
 * (products, pricing plans, how they meter usage, recent news, hiring signals,
 * tech stack), and delegates each to a subagent armed with its own Notte cloud
 * browser session. The coordinator then writes a single sales-ready brief.
 *
 * Requires `npm run setup` first, plus ANTHROPIC_API_KEY + NOTTE_API_KEY.
 * Run with: npm run lead-intel -- <url>
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
  console.error("Usage: npm run lead-intel -- <url>");
  console.error("Example: npm run lead-intel -- https://acme.com");
  process.exit(1);
}

const prompt = `Research ${url} as a sales lead and produce a single sales-ready brief.

1. Recon the site YOURSELF with one Notte browser session: \`notte sessions start
   --headless -o json\`, \`notte page goto\`, then \`notte page observe -o json\` to
   read the RENDERED nav and links. Identify which pages actually carry the
   commercially interesting information (product, pricing, docs, customers, blog,
   changelog, careers). Then stop your recon session.
2. Turn that into INDEPENDENT research tasks, ONE per subagent, run ALL in
   PARALLEL. Aim for these angles, dropping any the site clearly lacks:
     - What the product does, in the company's own words, and who it is for
     - Pricing plans and tiers, with actual numbers where published
     - How usage is metered or billed (seats, credits, requests, compute)
     - Named customers, logos, and case studies
     - Recent activity: latest blog or changelog entries and their dates
     - Hiring signals: open engineering roles and named stack from job posts
   Brief each operator with ONE angle, the specific page(s) to start from, and a
   HARD ${OPERATOR_TIMEBOX_MIN}-minute timebox; a partial but well-cited answer
   returned on time is exactly what you want. Tell each to use \`notte page scrape
   --instructions "..."\` for extraction, to pass --session-id explicitly on every
   call, and to stop its own session when done.
3. Synthesize ONE brief with these sections: What they do / Who they sell to /
   Pricing and metering / Customers / Recent momentum / Stack and hiring /
   Where a browser-automation vendor fits. Every non-obvious claim must cite the
   page it came from. Where an operator ran out of time, note the gap explicitly
   rather than guessing.

Never print NOTTE_API_KEY - it is an opaque placeholder.`;

async function main() {
  const { skillId } = await loadResources();
  const workerId = await findOrCreateAgent(workerAgentParams("lead-intel-worker", skillId));
  const coordinatorId = await findOrCreateAgent(
    coordinatorAgentParams("lead-intel-coordinator", workerId, skillId),
  );
  await runManagedAgent({
    agentId: coordinatorId,
    task: prompt,
    title: `Lead intel: ${url}`,
  });
}

main().then(
  () => console.error("\nlead-intel finished."),
  (err) => {
    console.error("\nlead-intel failed:", err);
    process.exitCode = 1;
  },
);
