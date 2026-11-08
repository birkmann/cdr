import { TEMPLATES } from "../templates.generated.js";

/** Groups of the docs navigation. */
export type ComponentGroup = "Actions" | "Forms" | "Feedback" | "Navigation" | "Content" | "Data";

/** What the generator knows of an element beyond its source: where it goes in the docs and how to show it. */
interface ElementEntry {
  /** tag without the prefix */
  tag: string;
  cls: string;
  /** template file under web-components/src (without .ts) */
  file: string;
  group: ComponentGroup;
  /** a child element documented with its parent */
  child?: boolean;
  /** HTML for the docs (`__P__` = prefix); several examples separated by blank lines are shown side by side */
  example?: string;
  /** how Angular forms bind it */
  form?: "value" | "checked";
}

const P = "__P__";

export const ELEMENTS: ElementEntry[] = [
  {
    tag: "button",
    cls: "Button",
    file: "components/button",
    group: "Actions",
    example: `<${P}-button>Primary</${P}-button>
<${P}-button kind="secondary">Secondary</${P}-button>
<${P}-button kind="tertiary">Tertiary</${P}-button>
<${P}-button kind="ghost">Ghost</${P}-button>
<${P}-button kind="danger">Delete</${P}-button>
<${P}-button kind="primary" icon="add">Add item</${P}-button>
<${P}-button disabled>Disabled</${P}-button>`,
  },
  {
    tag: "icon-button",
    cls: "IconButton",
    file: "components/icon-button",
    group: "Actions",
    example: `<${P}-icon-button label="More options" icon="overflow"></${P}-icon-button>
<${P}-icon-button label="Search" icon="search" kind="primary"></${P}-icon-button>`,
  },
  {
    tag: "link",
    cls: "Link",
    file: "components/link",
    group: "Actions",
    example: `<${P}-link href="#">Standalone link</${P}-link>
<p>Running text with an <${P}-link href="#" inline>inline link</${P}-link> inside.</p>
<${P}-link href="#" disabled>Disabled link</${P}-link>`,
  },
  {
    tag: "text-input",
    cls: "TextInput",
    file: "components/text-input",
    group: "Forms",
    form: "value",
    example: `<${P}-text-input label="Name" placeholder="Jane Doe" helper-text="As on your ID"></${P}-text-input>
<${P}-text-input label="Email" type="email" value="jane@" invalid invalid-text="Enter a valid email address"></${P}-text-input>
<${P}-text-input label="Disabled" value="Read only value" disabled></${P}-text-input>`,
  },
  {
    tag: "textarea",
    cls: "Textarea",
    file: "components/textarea",
    group: "Forms",
    form: "value",
    example: `<${P}-textarea label="Message" placeholder="How can we help?" maxlength="200" helper-text="Up to 200 characters"></${P}-textarea>`,
  },
  {
    tag: "select",
    cls: "Select",
    file: "components/select",
    group: "Forms",
    form: "value",
    example: `<${P}-select label="Country" helper-text="Where we ship to">
  <option value="de">Germany</option>
  <option value="fr">France</option>
  <option value="nl">Netherlands</option>
</${P}-select>`,
  },
  {
    tag: "dropdown",
    cls: "Dropdown",
    file: "components/dropdown",
    group: "Forms",
    form: "value",
    example: `<${P}-dropdown label="Plan" placeholder="Choose a plan">
  <option value="free">Free</option>
  <option value="team">Team</option>
  <option value="enterprise">Enterprise</option>
</${P}-dropdown>`,
  },
  {
    tag: "checkbox",
    cls: "Checkbox",
    file: "components/checkbox",
    group: "Forms",
    form: "checked",
    example: `<${P}-checkbox label="Subscribe to the newsletter" checked></${P}-checkbox>
<${P}-checkbox label="Mixed" indeterminate></${P}-checkbox>
<${P}-checkbox label="Disabled" disabled></${P}-checkbox>`,
  },
  {
    tag: "radio-group",
    cls: "RadioGroup",
    file: "components/radio-group",
    group: "Forms",
    form: "value",
    example: `<${P}-radio-group legend="Delivery" name="delivery" value="standard">
  <${P}-radio value="standard" label="Standard (3–5 days)"></${P}-radio>
  <${P}-radio value="express" label="Express (1 day)"></${P}-radio>
  <${P}-radio value="pickup" label="Pick up in store" disabled></${P}-radio>
</${P}-radio-group>`,
  },
  { tag: "radio", cls: "Radio", file: "components/radio-group", group: "Forms", child: true },
  {
    tag: "toggle",
    cls: "Toggle",
    file: "components/toggle",
    group: "Forms",
    form: "checked",
    example: `<${P}-toggle label="Notifications" checked></${P}-toggle>
<${P}-toggle label="Dark mode" size="sm"></${P}-toggle>`,
  },
  {
    tag: "search",
    cls: "Search",
    file: "components/search",
    group: "Forms",
    form: "value",
    example: `<${P}-search label="Search products" placeholder="Search products"></${P}-search>`,
  },
  {
    tag: "tag",
    cls: "Tag",
    file: "components/tag",
    group: "Content",
    example: `<${P}-tag>Gray</${P}-tag>
<${P}-tag type="brand">Brand</${P}-tag>
<${P}-tag type="success">Success</${P}-tag>
<${P}-tag type="warning">Warning</${P}-tag>
<${P}-tag type="error">Error</${P}-tag>
<${P}-tag type="info">Info</${P}-tag>
<${P}-tag type="outline" filter>Filter</${P}-tag>`,
  },
  {
    tag: "notification",
    cls: "Notification",
    file: "components/notification",
    group: "Feedback",
    example: `<${P}-notification kind="success" heading="Saved.">Your changes are live.</${P}-notification>
<${P}-notification kind="error" heading="Payment failed." low-contrast>Check the card details and try again.</${P}-notification>
<${P}-notification kind="info" heading="New version" toast caption="Just now">Reload to update.</${P}-notification>`,
  },
  {
    tag: "modal",
    cls: "Modal",
    file: "components/modal",
    group: "Feedback",
    example: `<${P}-button onclick="this.nextElementSibling.show()">Open modal</${P}-button>
<${P}-modal heading="Delete project?" label="Project settings" danger primary-button-text="Delete">
  <p>This removes the project and its history. This cannot be undone.</p>
</${P}-modal>`,
  },
  {
    tag: "tooltip",
    cls: "Tooltip",
    file: "components/tooltip",
    group: "Feedback",
    example: `<${P}-tooltip label="Copies the link to your clipboard">
  <${P}-button kind="tertiary">Copy link</${P}-button>
</${P}-tooltip>`,
  },
  {
    tag: "progress-bar",
    cls: "ProgressBar",
    file: "components/progress-bar",
    group: "Feedback",
    example: `<${P}-progress-bar label="Uploading" value="62" helper-text="62 of 100 MB"></${P}-progress-bar>
<${P}-progress-bar label="Preparing" indeterminate></${P}-progress-bar>
<${P}-progress-bar label="Done" status="finished"></${P}-progress-bar>`,
  },
  {
    tag: "loading",
    cls: "Loading",
    file: "components/loading",
    group: "Feedback",
    example: `<${P}-loading description="Loading results"></${P}-loading>
<${P}-loading size="small"></${P}-loading>`,
  },
  {
    tag: "tabs",
    cls: "Tabs",
    file: "components/tabs",
    group: "Navigation",
    example: `<${P}-tabs label="Account">
  <${P}-tab value="profile" label="Profile">Name, photo and contact details.</${P}-tab>
  <${P}-tab value="security" label="Security">Password and two-factor sign-in.</${P}-tab>
  <${P}-tab value="billing" label="Billing">Invoices and payment methods.</${P}-tab>
</${P}-tabs>`,
  },
  { tag: "tab", cls: "Tab", file: "components/tabs", group: "Navigation", child: true },
  {
    tag: "accordion",
    cls: "Accordion",
    file: "components/accordion",
    group: "Content",
    example: `<${P}-accordion>
  <${P}-accordion-item title="Shipping" open>We ship within 2 working days.</${P}-accordion-item>
  <${P}-accordion-item title="Returns">Return anything within 30 days.</${P}-accordion-item>
  <${P}-accordion-item title="Warranty">Two years on every product.</${P}-accordion-item>
</${P}-accordion>`,
  },
  {
    tag: "accordion-item",
    cls: "AccordionItem",
    file: "components/accordion",
    group: "Content",
    child: true,
  },
  {
    tag: "breadcrumb",
    cls: "Breadcrumb",
    file: "components/breadcrumb",
    group: "Navigation",
    example: `<${P}-breadcrumb>
  <${P}-breadcrumb-item href="#">Home</${P}-breadcrumb-item>
  <${P}-breadcrumb-item href="#">Products</${P}-breadcrumb-item>
  <${P}-breadcrumb-item current>Tents</${P}-breadcrumb-item>
</${P}-breadcrumb>`,
  },
  {
    tag: "breadcrumb-item",
    cls: "BreadcrumbItem",
    file: "components/breadcrumb",
    group: "Navigation",
    child: true,
  },
  {
    tag: "pagination",
    cls: "Pagination",
    file: "components/pagination",
    group: "Navigation",
    example: `<${P}-pagination total-items="128" page-size="10"></${P}-pagination>`,
  },
  {
    tag: "tile",
    cls: "Tile",
    file: "components/tile",
    group: "Content",
    example: `<${P}-tile><strong>Static tile</strong><p>Groups related content.</p></${P}-tile>
<${P}-tile variant="clickable" href="#"><strong>Clickable tile</strong><p>Opens a page.</p></${P}-tile>
<${P}-tile variant="selectable" label="Select the pro plan"><strong>Selectable tile</strong><p>Pro plan</p></${P}-tile>`,
  },
  {
    tag: "data-table",
    cls: "DataTable",
    file: "components/data-table",
    group: "Data",
    example: `<${P}-data-table heading="Orders" description="The last five orders" zebra></${P}-data-table>`,
  },
  {
    tag: "icon",
    cls: "Icon",
    file: "icons",
    group: "Content",
    example: `<${P}-icon name="success"></${P}-icon>
<${P}-icon name="warning"></${P}-icon>
<${P}-icon name="error"></${P}-icon>
<${P}-icon name="info"></${P}-icon>
<${P}-icon name="search"></${P}-icon>`,
  },
];

export interface PropInfo {
  name: string;
  attribute: string;
  type: string;
  description: string;
}
export interface EventInfo {
  /** DOM event name with the prefix placeholder, e.g. "change", "__P__-dismiss" */
  name: string;
  description: string;
}
export interface ElementInfo extends ElementEntry {
  summary: string;
  props: PropInfo[];
  events: EventInfo[];
  slots: string[];
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The class body of `cls` in a template source. */
function classBody(src: string, cls: string): { doc: string; body: string } {
  const at = src.indexOf(`export class ${cls} `);
  if (at < 0) throw new Error(`class ${cls} not found`);
  const docStart = src.lastIndexOf("/**", at);
  const doc = docStart >= 0 && src.slice(docStart, at).includes("*/") ? src.slice(docStart, at) : "";
  const next = src.indexOf("\nexport class ", at + 1);
  return { doc, body: src.slice(at, next < 0 ? undefined : next) };
}

const FORM_PROPS: PropInfo[] = [
  { name: "name", attribute: "name", type: "string", description: "form field name" },
  { name: "disabled", attribute: "disabled", type: "boolean", description: "" },
  { name: "required", attribute: "required", type: "boolean", description: "" },
];

/** Props, events, slots and the summary of one element, read from its template source. */
export function elementInfo(e: ElementEntry): ElementInfo {
  const src = TEMPLATES[`web-components/src/${e.file}.ts`];
  if (!src) throw new Error(`template ${e.file} missing`);
  const { doc, body } = classBody(src, e.cls);
  const summary = (/\/\*\*\s*\n\s*\*\s*([^\n@][^\n]*)/.exec(doc)?.[1] ?? "").trim();
  const events = [...doc.matchAll(/@fires\s+(\S+)\s+-\s+([^\n]*)/g)].map((m) => ({
    name: m[1]!,
    description: m[2]!.trim(),
  }));
  const slots = [...doc.matchAll(/@slot\s+(?:([\w-]+)\s+)?-\s/g)].map((m) => m[1] ?? "");
  const block = /static override properties = \{([\s\S]*?)\n {2}\}/.exec(body)?.[1] ?? "";
  const props: PropInfo[] = block.includes("...FormControl.properties") ? [...FORM_PROPS] : [];
  for (const m of block.matchAll(/^\s+(\w+): \{([^}]*)\}/gm)) {
    const name = m[1]!;
    if (/state: true/.test(m[2]!)) continue;
    const attribute = /attribute: '([^']+)'/.exec(m[2]!)?.[1] ?? kebab(name).toLowerCase();
    const decl = new RegExp(`(?:/\\*\\*\\s*([^*]*?)\\s*\\*/\\s*)?declare ${name}\\??: ([^\\n]+)`).exec(body);
    props.push({
      name,
      attribute,
      type: (decl?.[2] ?? "unknown").trim(),
      description: (decl?.[1] ?? "").trim(),
    });
  }
  return { ...e, summary, props, events, slots };
}

let cache: ElementInfo[] | undefined;
export function elements(): ElementInfo[] {
  return (cache ??= ELEMENTS.map(elementInfo));
}

/** React prop name of a DOM event: change → onChange, __P__-page-change → onPageChange. */
export function reactEventName(event: string): string {
  const bare = event.replace(/^__P__-/, "");
  return `on${bare.replace(/(^|-)(\w)/g, (_, _d, c: string) => c.toUpperCase())}`;
}
