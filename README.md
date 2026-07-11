# qts-dashboard

Static GitHub Pages dashboard for a personal quant **signal engine**.

**Signals only — the owner executes manually.** Nothing in this project
places orders, connects to a broker, or moves money. The numbers shown
are a *model* (paper) portfolio.

## What this repo contains

- A static page (`index.html` + `assets/`) — plain HTML/CSS/JS with
  Plotly from a CDN. No build step.
- **Generated serving JSON** under `data/` — pushed by CI from a private
  repository. These files are outputs (signals, simulated fills, daily
  marks); they are overwritten on every publish and should not be edited
  here.

## What this repo does NOT contain

All strategy code, parameters, research, cost-model calibration, and the
trial registry live in a **private** repository and are never published.
The serving JSON is redacted at that boundary: it carries results, not
the generator.

## Data contract

`data/manifest.json` lists the systems on display; per system the page
reads `systems/<id>/signals.json`, `ledger.json`, and `portfolio.json`
(all schema-versioned). The page renders whatever the manifest lists, so
new systems appear without page changes.
