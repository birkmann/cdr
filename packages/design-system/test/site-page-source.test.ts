import { describe, expect, it } from "vitest";
import { dataAliases, pageSource } from "../src/emit/site.js";

describe("pageSource", () => {
  const page = (...lines: string[]) => pageSource(lines.join("\n"), "@acme-ds");

  it("moves a default import with named types to the site package", () => {
    const out = page("import Card, { type CardProps } from '../components/Card'", "export default Card");
    expect(out).toContain("from '@acme-ds/site'");
    expect(out).toMatch(/\bCard\b.*type CardProps/);
    expect(out).not.toContain("../components");
  });

  it("moves data imports to the site package", () => {
    const out = page("import { cards, cards2 } from '../data/home'");
    expect(out).toContain("import { cards, cards2 } from '@acme-ds/site'");
    expect(out).not.toContain("../data");
  });

  it("keeps a plain default import and leaves package imports alone", () => {
    const out = page("import Hero from '../sections/Hero'", "import { useState } from 'react'");
    expect(out).toContain("import { Hero } from '@acme-ds/site'");
    expect(out).toContain("import { useState } from 'react'");
  });
});

describe("data modules that export the same name", () => {
  const files = {
    "src/data/footer.ts": "export const links = [1]\nexport const onlyFooter = 2\n",
    "src/data/news-list.ts": "export const links = [3]\n",
    "src/data/other.ts": "export const single = 4\n",
  };

  it("names them after their module and leaves the rest alone", () => {
    const a = dataAliases(files);
    expect([...a.keys()].sort()).toEqual(["footer", "news-list"]);
    expect(a.get("footer")!.get("links")).toBe("footerLinks");
    expect(a.get("news-list")!.get("links")).toBe("newsListLinks");
    expect(a.get("footer")!.has("onlyFooter")).toBe(false);
  });

  it("gives the page the renamed export under the name it uses", () => {
    const out = pageSource("import { links } from '../data/footer'\nlinks", "@acme-ds", dataAliases(files));
    expect(out).toContain("import { footerLinks as links } from '@acme-ds/site'");
  });
});
