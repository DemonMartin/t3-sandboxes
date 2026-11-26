import { isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { command } from "./io.mjs";
import { attachmentRequests } from "./attachments.mjs";
export async function launchProject(input) {
  if (typeof input.projectDirectory !== "string" || !isAbsolute(input.projectDirectory))
    throw new Error("Select a Git project on the controller first.");
  const directory = await realpath(input.projectDirectory);
  const repository = await command("git", ["-C", directory, "remote", "get-url", "origin"]);
  if (repository.startsWith("https://")) {
    const url = new URL(repository);
    if (url.username || url.password)
      throw new Error("Use a Git remote without embedded credentials.");
  }
  const base =
    typeof input.base === "string" && input.base
      ? input.base
      : await command("git", ["-C", directory, "rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Select a full pushed commit SHA.");
  return { directory, repository, base };
}
export async function validatePushedProject(project) {
  await command("git", ["-C", project.directory, "fetch", "origin"]);
  const refs = await command("git", [
    "-C",
    project.directory,
    "for-each-ref",
    "--contains",
    project.base,
    "--format=%(refname)",
    "refs/remotes/origin",
  ]);
  if (!refs) throw new Error("Push this base commit before starting a sandbox.");
}

export async function launchSandbox(controller, input) {
  if (!/^[a-f0-9-]{36}$/.test(input.requestId ?? "")) throw new Error("Invalid launch request id");
  if (!controller.snapshot().rows.some((row) => row.id === input.requestId)) {
    if (input.hasAttachments) throw new Error("Use a text-only first message.");
    const project = await launchProject(input);
    await validatePushedProject(project);
    const modelSelection =
      typeof input.modelSelection === "string" && input.modelSelection
        ? JSON.parse(input.modelSelection)
        : input.modelSelection;
    await controller.create({ ...input, ...project, modelSelection });
  }
  return { $t3: "environment-launch", requestId: input.requestId };
}

const git = (directory, ...args) => command("git", ["-C", directory, ...args]);
const firstLine = (message) => message.trim().split("\n", 1)[0].replace(/\s+/g, " ").slice(0, 80);

/**
 * The first send of a new chat, offered to the plugin before the host sends it locally.
 * Returns null to decline (the chat then runs on this machine); throws when a sandbox was
 * wanted but cannot be started, so the message never silently runs unsandboxed. `stage` keeps
 * the message's attachments for the launch and returns what the sandbox record holds of them.
 */
export async function autoLaunch(controller, input, stage = async () => []) {
  const { policy, profiles, rows } = controller.snapshot();
  if (!policy.autoSandbox || !profiles.length) return null;
  if (!/^[a-f0-9-]{36}$/.test(input.requestId ?? "")) throw new Error("Invalid launch request id");
  if (!rows.some((row) => row.id === input.requestId)) {
    if (typeof input.message !== "string" || !input.message.trim())
      throw new Error("Write a first message to start the sandbox with.");
    // Images and files travel with the message; context only this machine has cannot.
    if (input.hasAttachments)
      throw new Error(
        "A sandbox cannot start from the context attached to this message. Remove it (images and files are fine), or switch Run on to this machine.",
      );
    const attachments = attachmentRequests(input.attachments);
    const project = await launchProject(input).catch(() => {
      throw new Error(
        "A sandbox needs a Git project with an origin remote. Switch Run on to this machine to work here.",
      );
    });
    // Start from what is on the remote, not from this checkout: the branch picked in the
    // composer (or checked out here) when it exists there, otherwise the remote's default.
    await git(project.directory, "fetch", "--prune", "origin");
    const branch =
      typeof input.branch === "string" && /^[A-Za-z0-9._\/-]+$/.test(input.branch)
        ? input.branch.replace(/^origin\//, "")
        : await git(project.directory, "rev-parse", "--abbrev-ref", "HEAD");
    const base =
      (await git(
        project.directory,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}`,
      ).catch(() => "")) ||
      (await git(
        project.directory,
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/HEAD",
      ).catch(() => "")) ||
      (await git(project.directory, "ls-remote", "origin", "HEAD")).split(/\s/, 1)[0];
    const modelSelection =
      typeof input.modelSelection === "string" && input.modelSelection
        ? JSON.parse(input.modelSelection)
        : input.modelSelection;
    await controller.create({
      ...input,
      ...project,
      base,
      profile: profiles[0].id,
      title: firstLine(input.message),
      autoTitle: true,
      modelSelection,
      attachments: await stage(input.requestId, attachments),
    });
  }
  return { $t3: "environment-launch", requestId: input.requestId };
}
