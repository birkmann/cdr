# Form screenshot demo

A responsive concept store used by the scripted demo provider. The page lives in the built-in `web-app` skill as [`packages/core/skills/web-app/reference/form.html`](../../../packages/core/skills/web-app/reference/form.html), so real models can study the same app the demo shows. The harness writes it into a real sandbox and publishes it through the normal preview tools. No model API calls or payment services are involved.

The README screenshot therefore comes from this scripted run. `node scripts/screenshots/capture.mjs web --real --model <provider/model>` repeats the same capture with a real model and the `web-app` skill, and saves the result separately (see [docs/skills.md](../../../docs/skills.md)).

The design uses a white canvas, large sans-serif type, grey product tiles and a restrained orange accent. Phones show a full-width lead product followed by a two-column catalogue; larger viewports use an asymmetric four-column grid. Product details include size selection, expandable descriptions and a fixed mobile add-to-bag action.

Category filtering, the mobile navigation, quantity changes, removing items, bag persistence and demo checkout all work. Product names, descriptions and prices are illustrative. No real orders are placed. Images require internet access; the catalogue and bag logic run locally.

## Photography

Unsplash photography is hotlinked using the original API image URLs, with photographer links in the app footer. Photo selections were registered through the Unsplash download endpoint.

- [Luis Felipe Lins](https://unsplash.com/photos/white-and-orange-athletic-sneaker-LG88A2XgIXY) — A white and orange athletic sneaker floating against a plain light background
- [Jason Mitrione](https://unsplash.com/photos/a-pair-of-headphones-sitting-on-top-of-a-table-wjEcEOI8rWg) — a pair of headphones sitting on top of a table
- [James Jeremy Beckers](https://unsplash.com/photos/a-black-camera-on-a-white-background-pWhFcl-LvXI) — A black camera on a white background
- [K8](https://unsplash.com/photos/white-and-black-leather-handbag-VDow9qDDMKc) — white and black leather handbag

## Regenerate and verify

Run `pnpm build`, then `node scripts/screenshots/capture.mjs web`. Chrome and network access to `images.unsplash.com` are required.

The capture script saves the CDR preview, mobile catalogue, mobile product detail and desktop catalogue. It checks filtering, size selection, bag totals, reload persistence, checkout, mobile navigation, item removal, Escape dismissal, JavaScript errors, and overflow at 320, 390, 768 and 1280 px. It also checks that the mobile add action is visible without scrolling.
