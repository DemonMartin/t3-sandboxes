import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_COUNT = 8;
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * The images and files a first message carries: what each is, and a URL on the controller its
 * bytes can be read from. Anything malformed is refused instead of starting without it.
 */
export function attachmentRequests(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_COUNT)
    throw new Error(`A first message can carry up to ${MAX_COUNT} attachments.`);
  return value.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !["image", "file"].includes(item.type) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 255 ||
      typeof item.mimeType !== "string" ||
      !item.mimeType ||
      item.mimeType.length > 100 ||
      !Number.isInteger(item.sizeBytes) ||
      item.sizeBytes < 1 ||
      typeof item.url !== "string" ||
      !/^\/(?!\/)/.test(item.url)
    )
      throw new Error("An attachment could not be read. Attach it again.");
    if (item.sizeBytes > MAX_BYTES)
      throw new Error(`${item.name} is too large to attach (50 MB at most).`);
    return {
      type: item.type,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      url: item.url,
    };
  });
}

/**
 * Copies a launch's attachments from the controller into `directory`. The client's uploads are
 * its own to delete, and a sandbox can take minutes to come up, so the launch keeps the bytes.
 */
export async function stageAttachments({ directory, base, attachments, fetcher = fetch }) {
  if (!attachments.length) return [];
  const origin = new URL(base).origin;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await Promise.all(
      attachments.map(async ({ url, ...attachment }, index) => {
        const target = new URL(url, base);
        // Only this controller's own files: the URL comes from a client.
        if (target.origin !== origin) throw new Error("An attachment could not be read.");
        const response = await fetcher(target, { signal: AbortSignal.timeout(120000) });
        const bytes = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
        if (bytes?.length !== attachment.sizeBytes)
          throw new Error(`${attachment.name} could not be read. Attach it again.`);
        const path = join(directory, String(index));
        await writeFile(path, bytes, { mode: 0o600 });
        return { ...attachment, path };
      }),
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Uploads staged attachments to a sandbox's server; returns what its thread launch refers to. */
export async function uploadAttachments(guest, staged) {
  const sent = [];
  for (const { path, ...attachment } of staged) {
    const prepared = await guest.call("t3_attachment_prepare_upload", { upload: attachment });
    await guest.upload(prepared.relativeUrl, await readFile(path), attachment.mimeType);
    sent.push({ ...attachment, id: prepared.attachmentId });
  }
  return sent;
}

/** Drops the staged files of launches that never reached their thread. */
export async function sweepAttachments(root, now = Date.now(), maxAge = 24 * 3600000) {
  for (const name of await readdir(root).catch(() => [])) {
    const directory = join(root, name);
    const info = await stat(directory).catch(() => null);
    if (info && now - info.mtimeMs > maxAge) await rm(directory, { recursive: true, force: true });
  }
}
