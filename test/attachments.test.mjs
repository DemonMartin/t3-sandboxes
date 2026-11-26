import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attachmentRequests,
  stageAttachments,
  sweepAttachments,
  uploadAttachments,
} from "../src/attachments.mjs";

const file = { type: "file", name: "trace.har", mimeType: "application/json", sizeBytes: 5 };

test("a first message's attachments are described completely or refused", () => {
  assert.deepEqual(attachmentRequests(undefined), []);
  assert.deepEqual(attachmentRequests([{ ...file, url: "/api/assets/x", extra: 1 }]), [
    { ...file, url: "/api/assets/x" },
  ]);
  for (const bad of [
    { ...file, url: "https://elsewhere.example/x" },
    { ...file, url: "//elsewhere.example/x" },
    { ...file, url: "/x", sizeBytes: 0 },
    { ...file, url: "/x", type: "folder" },
    { ...file, url: "/x", name: " " },
  ])
    assert.throws(() => attachmentRequests([bad]), /could not be read/);
  assert.throws(
    () => attachmentRequests([{ ...file, url: "/x", sizeBytes: 60 * 1024 * 1024 }]),
    /too large/,
  );
  assert.throws(() => attachmentRequests(Array(9).fill({ ...file, url: "/x" })), /up to 8/);
});

test("attachments are copied from the controller, uploaded to the sandbox and named in the launch", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "attachments-")), "request");
  const asked = [];
  const staged = await stageAttachments({
    directory,
    base: "http://127.0.0.1:3773",
    attachments: [{ ...file, url: "/api/assets/signed" }],
    fetcher: async (url) => {
      asked.push(String(url));
      return new Response("hello");
    },
  });
  assert.deepEqual(asked, ["http://127.0.0.1:3773/api/assets/signed"]);
  assert.deepEqual(staged, [{ ...file, path: join(directory, "0") }]);
  assert.equal(await readFile(staged[0].path, "utf8"), "hello");

  const uploads = [];
  const sent = await uploadAttachments(
    {
      call: async (name, input) => {
        assert.equal(name, "t3_attachment_prepare_upload");
        assert.deepEqual(input, { upload: file });
        return { attachmentId: "pending-1-har", relativeUrl: "/api/attachments/upload/token" };
      },
      upload: async (location, bytes, mimeType) =>
        uploads.push([location, bytes.toString(), mimeType]),
    },
    staged,
  );
  assert.deepEqual(uploads, [["/api/attachments/upload/token", "hello", "application/json"]]);
  assert.deepEqual(sent, [{ ...file, id: "pending-1-har" }]);
});

test("a file that is not the one described is refused and nothing is kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "attachments-"));
  const directory = join(root, "request");
  await assert.rejects(
    stageAttachments({
      directory,
      base: "http://127.0.0.1:3773",
      attachments: [{ ...file, url: "/api/assets/signed" }],
      fetcher: async () => new Response("other bytes"),
    }),
    /trace\.har could not be read/,
  );
  await assert.rejects(
    stageAttachments({
      directory,
      base: "http://127.0.0.1:3773",
      attachments: [{ ...file, url: "/api/assets/gone" }],
      fetcher: async () => new Response("", { status: 404 }),
    }),
    /could not be read/,
  );
  assert.deepEqual(await readdir(root), []);
});

test("staged files of launches that never started are dropped after a day", async () => {
  const root = await mkdtemp(join(tmpdir(), "attachments-"));
  await mkdir(join(root, "old"));
  await mkdir(join(root, "new"));
  const then = new Date(Date.now() - 25 * 3600000);
  await utimes(join(root, "old"), then, then);
  await sweepAttachments(root);
  assert.deepEqual(await readdir(root), ["new"]);
});
