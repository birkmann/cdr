import type { FrontendGenerator } from "@harness/mirror-core";
import { generate } from "./generate.js";

/** design/ + ccm/ → apps/<site>-web (Next.js App Router + Contentful/CCM data layer). */
export const nextjsContentfulGenerator: FrontendGenerator = { id: "nextjs-contentful", generate };

export { generate, planGeneration, buildRedirects, rewriteCssUrls, typesTs, siteOverridesLast, TEMPLATE_DIR, type GenerateOptions } from "./generate.js";
export { compileTemplate, compileComponentModule, pascalCase, TemplateCompileError } from "./compile.js";
export { readDesign, tokensToCss } from "./design.js";
