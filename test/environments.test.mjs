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

test("a sandbox can have its own idle window, and says when it will stop", async () => {
  const { decide, effective, outlook } = await import("../src/policy.mjs");
  const minute = 60000;
  const p = policy({ idleMinutes: 10, continuousMinutes: 720 });
  const row = {
    desired: "running",
    state: "running",
    startedAt: 0,
    lastActivity: 0,
    idleMinutes: 1440,
  };
  const idle = { active: false, waiting: false, closed: false, lastActivity: 0, threads: [{}] };
  const mine = effective(p, row);
  assert.equal(mine.idleMinutes, 1440);
  // a day-long idle window is not cut short by the default lifetime
  assert.equal(decide(row, idle, 13 * 60 * minute, mine), "running");
  assert.equal(decide(row, idle, 24 * 60 * minute, mine), "stopped");
  assert.deepEqual(outlook({ ...row, activity: idle }, 60 * minute, mine), {
    reason: "idle",
    at: 1440 * minute,
  });
  assert.equal(outlook({ ...row, activity: { ...idle, active: true } }, minute, mine), null);
});

test("a long thread id still gets a file name the filesystem accepts", async () => {
  const { threadFileKey } = await import("../src/io.mjs");
  const short = "mcp:3a822ea1-d1bf-46a5-9187-2217a5279701";
  assert.equal(threadFileKey(short), Buffer.from(short).toString("hex"));
  const long = `thread:delegated-task:${"command%3Amcp%3A2d77f396-858e-451c-8c5e-c57ea8b8ec69%3Adelegate-task%3A".repeat(2)}`;
  const key = threadFileKey(long);
  assert.match(key, /^sha256-[a-f0-9]{64}$/);
  assert.ok(`${key}.json.${"x".repeat(36)}`.length < 255);
  assert.notEqual(key, threadFileKey(long + "b"));
});
