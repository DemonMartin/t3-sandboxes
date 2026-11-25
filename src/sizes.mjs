/** Resource presets a sandbox can be given. The first three ship by default; "low" is the default. */
export const defaultSizes = Object.freeze([
  Object.freeze({ id: "low", cpus: 4, memoryGb: 16 }),
  Object.freeze({ id: "medium", cpus: 8, memoryGb: 32 }),
  Object.freeze({ id: "high", cpus: 16, memoryGb: 48 }),
]);
export function sizeEntry(input) {
  const id = String(input.id ?? "")
    .trim()
    .toLowerCase();
  const cpus = Number(input.cpus);
  const memoryGb = Number(input.memoryGb);
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id))
    throw new Error("A size needs a short name (letters, digits, dashes)");
  if (!Number.isFinite(cpus) || cpus < 0.5 || cpus > 512)
    throw new Error("CPU cores must be between 0.5 and 512");
  if (!Number.isFinite(memoryGb) || memoryGb < 1 || memoryGb > 4096)
    throw new Error("Memory must be between 1 and 4096 GB");
  return { id, cpus, memoryGb };
}
export const sizeLabel = (size) =>
  `${size.id[0].toUpperCase()}${size.id.slice(1)} · ${size.cpus} cores · ${size.memoryGb} GB`;
