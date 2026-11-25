import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomic } from "./io.mjs";

/** `https://github.com/Owner/Repo.git` and `git@github.com:owner/repo` name the same environment. */
export function repositoryKey(remote) {
  return String(remote)
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

const empty = Object.freeze({ setup: "", start: "", env: "" });

/**
 * One environment per repository: a setup script (run once, then snapshotted by
 * drivers that can), a start script (run on every sandbox start) and extra
 * environment variables. Kept in the plugin's private data directory.
 */
export async function createEnvironments(directory) {
  const file = join(directory, "environments.json");
  // Read on every use: the file can also be edited by hand.
  const load = async () => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return {};
    }
  };
  return {
    get: async (remote) => ({ ...empty, ...(await load())[repositoryKey(remote)] }),
    async set(remote, input) {
      const value = Object.fromEntries(
        Object.keys(empty).map((key) => [key, String(input[key] ?? "").replaceAll("\r\n", "\n")]),
      );
      for (const line of value.env.split("\n")) {
        const entry = line.trim();
        if (entry && !entry.startsWith("#") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry))
          throw new Error("Environment variables are one KEY=VALUE per line");
      }
      await atomic(file, { ...(await load()), [repositoryKey(remote)]: value });
    },
  };
}
