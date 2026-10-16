import { describe, it, expect } from "vitest";
import {
  resolveRoute,
  sectionLabel,
  reportPrompt,
  type Section,
} from "../sections";
const parent: Section = {
  id: "parent",
  projectId: "p",
  hostId: "h",
  name: "Плагины",
  parentId: null,
  path: "/plugins",
  kind: "folder",
};
const section: Section = {
  id: "target",
  projectId: "p",
  hostId: "h",
  name: "plugin",
  parentId: "parent",
  path: "/plugins/plugin",
  kind: "folder",
};
const config = {
  projectId: "p",
  hostId: "h",
  checkouts: { "owner/plugin": "/plugins/plugin/" },
  bindings: {},
};
describe("repository routing", () => {
  it("matches the exact host path, project and nested section", () => {
    expect(
      resolveRoute("owner/plugin", config, [parent, section]),
    ).toMatchObject({
      folderId: "target",
      projectId: "p",
      label: "Плагины / plugin",
      status: "ready",
    });
  });
  it("never falls back to the parent plugins root or another host", () => {
    expect(
      resolveRoute("owner/plugin", config, [
        parent,
        { ...section, hostId: "other" },
      ]).status,
    ).toBe("sectionMissing");
  });
  it("prefers the shallow canonical section when child sections reuse its path", () => {
    expect(
      resolveRoute("owner/plugin", config, [
        { ...section, id: "child", parentId: "target" },
        parent,
        section,
      ]).folderId,
    ).toBe("target");
  });
  it("keeps an explicitly chosen filing section separate from the checkout", () => {
    const other = {
      ...section,
      id: "other",
      name: "Other",
      path: "/elsewhere",
    };
    const binding = {
      projectId: "p",
      folderId: "other",
      hostId: "h",
      checkoutPath: "/plugins/plugin",
    };
    expect(
      resolveRoute(
        "owner/plugin",
        { ...config, bindings: { "owner/plugin": binding } },
        [other],
      ),
    ).toMatchObject({
      folderId: "other",
      checkoutPath: "/plugins/plugin",
      status: "ready",
    });
  });
  it("blocks deleted bindings and missing checkouts", () => {
    expect(
      resolveRoute(
        "owner/plugin",
        {
          ...config,
          bindings: {
            "owner/plugin": {
              projectId: "p",
              folderId: "gone",
              hostId: "h",
              checkoutPath: "/plugins/plugin",
            },
          },
        },
        [parent, section],
      ).status,
    ).toBe("bindingInvalid");
    expect(resolveRoute("owner/missing", config, [parent]).status).toBe(
      "configureCheckout",
    );
  });
  it("bounds cyclic ancestry and generates a genuinely read-only QA prompt", () => {
    expect(sectionLabel({ ...section, parentId: "target" }, [section])).toBe(
      "plugin",
    );
    expect(
      reportPrompt(
        "owner/plugin",
        "https://github.com/owner/plugin/actions/runs/1",
        "/plugins/plugin",
      ),
    ).toContain("Do not edit any file, create a branch");
  });
});
