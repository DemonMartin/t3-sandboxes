import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvironments, repositoryKey } from "../src/environments.mjs";
import { autoLaunch } from "../src/launch.mjs";
import { policy } from "../src/policy.mjs";

test("one environment per repository, however its remote is written", async () => {
  assert.equal(repositoryKey("https://github.com/Owner/Repo.git"), "github.com/owner/repo");
  assert.equal(repositoryKey("git@github.com:owner/repo"), "github.com/owner/repo");
  const directory = await mkdtemp(join(tmpdir(), "environments-"));
  const environments = await createEnvironments(directory);
  assert.deepEqual(await environments.get("https://github.com/o/r"), {
    setup: "",
    start: "",
    env: "",
  });
  await environments.set("https://github.com/O/R.git", {
    setup: "pnpm install\r\npnpm build",
    env: "# comment\nTOKEN=a=b\n",
  });
  const reopened = await createEnvironments(directory);
  assert.deepEqual(await reopened.get("git@github.com:o/r.git"), {
    setup: "pnpm install\npnpm build",
    start: "",
    env: "# comment\nTOKEN=a=b\n",
  });
  assert.equal((await stat(join(directory, "environments.json"))).mode & 0o777, 0o600);
  assert.ok((await readFile(join(directory, "environments.json"), "utf8")).includes("TOKEN=a=b"));
  await assert.rejects(environments.set("https://github.com/o/r", { env: "not a variable" }));
});

test("auto launch declines when switched off and refuses to fall back silently when on", async () => {
  const controller = (autoSandbox, profiles = [{ id: "p" }]) => ({
    snapshot: () => ({ policy: policy({ autoSandbox }), profiles, rows: [] }),
    create: () => assert.fail("must not create"),
  });
  const input = { requestId: "00000000-0000-4000-8000-000000000001", message: "hello" };
  assert.equal(await autoLaunch(controller(false), input), null);
  assert.equal(await autoLaunch(controller(true, []), input), null);
  await assert.rejects(
    autoLaunch(controller(true), { ...input, hasAttachments: true }),
    /text-only/,
  );
  await assert.rejects(autoLaunch(controller(true), { ...input, message: " " }), /first message/);
  await assert.rejects(
    autoLaunch(controller(true), { ...input, projectDirectory: "/nonexistent-project" }),
    /Git project/,
  );
  assert.throws(() => policy({ autoSandbox: 1 }));
});

test("a settled sandbox stops, after a short grace when it was only just started", async () => {
  const { decide } = await import("../src/policy.mjs");
  const p = policy({ idleMinutes: 10 });
  const minute = 60000;
  const row = { desired: "running", startedAt: 100 * minute, lastActivity: 100 * minute };
  const settled = { closed: true, active: false, waiting: false, threads: [{ threadId: "t" }] };
  assert.equal(decide(row, settled, 101 * minute, p), "running");
  assert.equal(decide(row, settled, 102 * minute, p), "stopped");
  // deleting the last thread is not a pause to look around
  assert.equal(decide(row, { ...settled, threads: [] }, 100 * minute, p), "stopped");
});
