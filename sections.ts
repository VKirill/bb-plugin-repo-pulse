import { z } from "zod";
export const sectionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  hostId: z.string(),
  kind: z.enum(["folder", "group"]),
});
export type Section = z.infer<typeof sectionSchema>;
export const bindingSchema = z.object({
  projectId: z.string().min(1),
  folderId: z.string().min(1),
  hostId: z.string().min(1),
  checkoutPath: z.string().min(1),
});
export type Binding = z.infer<typeof bindingSchema>;
export const routeSchema = z.object({
  repo: z.string(),
  projectId: z.string(),
  hostId: z.string(),
  checkoutPath: z.string(),
  folderId: z.string().nullable(),
  label: z.string(),
  status: z.enum([
    "ready",
    "configureCheckout",
    "sectionMissing",
    "bindingInvalid",
  ]),
});
export type Route = z.infer<typeof routeSchema>;
export function normalizedPath(value: string) {
  return value.replace(/\/+$/, "") || "/";
}
export function sectionLabel(section: Section, sections: Section[]): string {
  const names = [section.name];
  let parent = section.parentId;
  const seen = new Set([section.id]);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const row = sections.find((s) => s.id === parent);
    if (!row) break;
    names.unshift(row.name);
    parent = row.parentId;
  }
  return names.join(" / ");
}
export function resolveRoute(
  repo: string,
  config: {
    projectId: string;
    hostId: string;
    checkouts: Record<string, string>;
    bindings: Record<string, Binding>;
  },
  sections: Section[],
): Route {
  const manual = config.bindings[repo];
  const checkoutPath = manual?.checkoutPath ?? config.checkouts[repo] ?? "";
  const hostId = manual?.hostId ?? config.hostId;
  const projectId = manual?.projectId ?? config.projectId;
  const base = {
    repo,
    checkoutPath,
    hostId,
    projectId,
    folderId: null,
    label: "",
  };
  if (!checkoutPath || !hostId) return { ...base, status: "configureCheckout" };
  const candidates = sections.filter(
    (s) =>
      s.kind === "folder" &&
      s.hostId === hostId &&
      normalizedPath(s.path) === normalizedPath(checkoutPath),
  );
  const section = manual
    ? sections.find(
        (s) =>
          s.id === manual.folderId &&
          s.projectId === manual.projectId &&
          s.hostId === manual.hostId &&
          s.kind === "folder",
      )
    : candidates.sort(
        (a, b) =>
          Number(b.projectId === projectId) -
            Number(a.projectId === projectId) ||
          sectionLabel(a, sections).split("/").length -
            sectionLabel(b, sections).split("/").length,
      )[0];
  if (!section)
    return { ...base, status: manual ? "bindingInvalid" : "sectionMissing" };
  return {
    ...base,
    projectId: section.projectId,
    folderId: section.id,
    label: sectionLabel(section, sections),
    status: "ready",
  };
}
export function reportPrompt(repo: string, url: string, checkoutPath: string) {
  return `READ-ONLY REPORT MODE. The owner authorizes only reading this repository and the linked GitHub request, discussion or CI run. Start by running pwd and git status --short; report the working directory. Read the linked item, analyze what is requested and summarize your recommendation in Russian. Do not edit any file, create a branch, commit, push, merge, release, post comments, or close items. Do not delegate or spawn agents. Stop after your short report. This report mode overrides any standing maintenance instructions.\nGitHub data: ${JSON.stringify({ repo, url, checkoutPath })}`;
}
