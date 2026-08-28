/**
 * One-time setup for the Notte x Claude Managed Agents cookbook.
 *
 * Creates the durable, workspace-scoped infra every recipe reuses:
 *   1. a cloud ENVIRONMENT with the notte CLI go-installed and limited networking
 *   2. a VAULT + environment_variable CREDENTIAL holding NOTTE_API_KEY
 *   3. the upstream Notte browser skill uploaded from its Git submodule
 *
 * The created ids are persisted to .notte-agent.json via saveResources() so the
 * recipes (src/ux-swarm.ts, src/lead-intel.ts, ...) can load them.
 *
 * Run with: npm run setup
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { toFile, type Uploadable } from "@anthropic-ai/sdk";
import {
  client,
  ENV_BUILD_WAIT_MS,
  GO_TOOLCHAIN_HOSTS,
  NOTTE_CLI_PACKAGE,
  NOTTE_NETWORK_HOSTS,
  NOTTE_SECRET_HOSTS,
  saveResources,
  type Resources,
} from "./config";

// Keep the skill source tied to nottelabs/notte-skills rather than maintaining
// a local copy that can drift from the CLI's documented workflow.
const SKILL_DIR = path.join(
  process.cwd(),
  "skills",
  "notte-skills",
  "plugins",
  "notte",
  "skills",
  "notte-browser",
);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`\nMissing required environment variable: ${name}`);
    console.error(`Set it before running setup. See .env.example for the full list.`);
    if (name === "NOTTE_API_KEY") {
      console.error(`Get a Notte API key from https://console.notte.cc/apikeys`);
    }
    process.exit(1);
  }
  return value;
}

/**
 * Every file under the skill directory, named RELATIVE to the skill's parent so
 * each upload arrives as `notte-browser/SKILL.md`. Passing a read stream instead
 * sends the absolute path as the filename, which the API rejects with
 * "Skill contains absolute path".
 */
async function skillFiles(dir: string): Promise<Uploadable[]> {
  const parent = path.dirname(dir);
  const out: Uploadable[] = [];
  async function walk(d: string) {
    for (const entry of await readdir(d)) {
      const full = path.join(d, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else out.push(await toFile(await readFile(full), path.relative(parent, full)));
    }
  }
  await walk(dir);
  return out;
}

async function main() {
  requireEnv("ANTHROPIC_API_KEY");
  const notteApiKey = requireEnv("NOTTE_API_KEY");

  console.log("Setting up Notte x Managed Agents cookbook infrastructure...\n");

  // 1. ENVIRONMENT - the sandbox the workers run in.
  //    - packages.go: installs the notte CLI into the image so workers can run
  //      `notte` immediately, with no per-run install (and no race between
  //      parallel workers all installing it at once).
  //    - networking "limited": Notte's control plane, PLUS the Go module proxy.
  //      allow_package_managers covers npm and PyPI but NOT proxy.golang.org, so
  //      without GO_TOOLCHAIN_HOSTS the go install silently yields no binary.
  const env = await client.beta.environments.create({
    name: `notte-cookbook-env-${Date.now()}`,
    config: {
      type: "cloud",
      packages: { go: [NOTTE_CLI_PACKAGE] },
      networking: {
        type: "limited",
        allow_package_managers: true,
        allow_mcp_servers: false,
        allowed_hosts: [...NOTTE_NETWORK_HOSTS, ...GO_TOOLCHAIN_HOSTS],
      },
    },
  });
  console.log(`Environment: ${env.id}`);

  // 2. VAULT - a workspace-scoped container for the credential. Anyone with a
  //    workspace API key can reference it by id; the secret itself is write-only
  //    and never returned by the API.
  const vault = await client.beta.vaults.create({
    display_name: "Notte cookbook vault",
    metadata: { purpose: "notte-cookbook" },
  });
  console.log(`Vault: ${vault.id}`);

  // 3. CREDENTIAL - the credential networking plane. The sandbox env var holds an
  //    opaque placeholder; the real secret_value below is substituted into an
  //    outbound request only when the placeholder appears in a request to one of
  //    these allowed_hosts.
  const cred = await client.beta.vaults.credentials.create(vault.id, {
    display_name: "Notte API key",
    auth: {
      type: "environment_variable",
      secret_name: "NOTTE_API_KEY",
      secret_value: notteApiKey,
      networking: {
        type: "limited",
        allowed_hosts: NOTTE_SECRET_HOSTS,
      },
    },
  });
  console.log(`Credential: ${cred.id}`);

  // 4. SKILL - the upstream notte-browser skill. Attached to both the
  //    coordinator and the operators so CLI usage patterns come from a
  //    versioned skill rather than being inlined in every system prompt.
  let skillId: string | undefined;
  try {
    const files = await skillFiles(SKILL_DIR);
    const skill = await client.beta.skills.create({
      display_title: "Notte browser CLI",
      files,
    });
    skillId = skill.id;
    console.log(`Skill: ${skill.id} (${files.length} file(s))`);
  } catch (err) {
    console.error(
      `\nSkill upload failed (continuing without it - recipes still work, ` +
        `they just fall back to the inline prompt):\n  ${String(err).slice(0, 300)}`,
    );
  }

  const resources: Resources = {
    environmentId: env.id,
    vaultId: vault.id,
    credentialId: cred.id,
    skillId,
  };
  await saveResources(resources);

  // Package installation is asynchronous and the environment reports "active"
  // immediately, so a session created now would see an image with no notte CLI.
  console.log(
    `\nWaiting ${ENV_BUILD_WAIT_MS / 1000}s for the environment image to finish ` +
      `installing the notte CLI...`,
  );
  await new Promise((r) => setTimeout(r, ENV_BUILD_WAIT_MS));

  console.log("\n--- Setup complete ---");
  console.log(`Environment ID: ${resources.environmentId}`);
  console.log(`Vault ID:       ${resources.vaultId}`);
  console.log(`Credential ID:  ${resources.credentialId}`);
  console.log(`Skill ID:       ${resources.skillId ?? "(none)"}`);
  console.log(`\nSaved to .notte-agent.json.`);
  console.log(`Next: 'npm run preflight' to verify the sandbox wiring, then run a recipe.`);
}

main().catch((err) => {
  console.error("\nSetup failed:", err);
  process.exitCode = 1;
});
