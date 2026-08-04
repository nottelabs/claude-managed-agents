/**
 * Teardown for the Notte x Claude Managed Agents cookbook.
 *
 * Deletes the environment, deletes the vault (which cascades to its credentials),
 * deletes the uploaded skill, and ARCHIVES the cookbook's agents (agents have no
 * delete; archive is the terminal state). Then removes .notte-agent.json.
 *
 * Run with: npm run teardown
 */
import { promises as fs } from "node:fs";
import { COOKBOOK_TAG, RESOURCES_PATH, client, loadResources } from "./config";

async function main() {
  const res = await loadResources().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });

  // Archive every agent this cookbook created, identified by its metadata tag.
  // list() excludes already-archived agents, so this is idempotent.
  for await (const agent of client.beta.agents.list()) {
    if (agent.metadata?.managed_by !== COOKBOOK_TAG) continue;
    try {
      await client.beta.agents.archive(agent.id);
      console.log(`Archived agent ${agent.name} (${agent.id})`);
    } catch (err) {
      console.error(`Failed to archive agent ${agent.id}:`, String(err).slice(0, 200));
    }
  }

  // A skill cannot be deleted while any of its versions still exist:
  // "Cannot delete skill with existing versions. Delete all versions first."
  // Collect the ids first, then delete, so we are not mutating the collection
  // we are paging through.
  if (res.skillId) {
    try {
      const versionIds: string[] = [];
      for await (const v of client.beta.skills.versions.list(res.skillId)) {
        versionIds.push(v.version);
      }
      for (const version of versionIds) {
        await client.beta.skills.versions.delete(version, { skill_id: res.skillId });
        console.log(`Deleted skill version ${version}`);
      }
      await client.beta.skills.delete(res.skillId);
      console.log(`Deleted skill ${res.skillId}`);
    } catch (err) {
      console.error(`Failed to delete skill ${res.skillId}:`, String(err).slice(0, 200));
    }
  }

  // Deleting the vault cascades to the credentials inside it.
  try {
    await client.beta.vaults.delete(res.vaultId);
    console.log(`Deleted vault ${res.vaultId}`);
  } catch (err) {
    console.error(`Failed to delete vault ${res.vaultId}:`, String(err).slice(0, 200));
  }

  try {
    await client.beta.environments.delete(res.environmentId);
    console.log(`Deleted environment ${res.environmentId}`);
  } catch (err) {
    console.error(
      `Failed to delete environment ${res.environmentId}:`,
      String(err).slice(0, 200),
    );
  }

  await fs.rm(RESOURCES_PATH, { force: true });
  console.log(`Removed ${RESOURCES_PATH}`);
  console.log("\n--- Teardown complete ---");
}

main().catch((err) => {
  console.error("\nTeardown failed:", err);
  process.exitCode = 1;
});
