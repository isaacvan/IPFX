// The trial registry: every configuration ever backtested, successful or not. The Deflated Sharpe
// Ratio is only honest if it is charged for all of them, including the ones that were thrown away
// and the ones run last month. Append-only JSONL in the git-ignored .data folder (results and
// data never go in the public repository).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR = process.env.STRATEGY_ENGINE_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), ".data");

export class Registry {
  constructor(file = path.join(DATA_DIR, "trials.jsonl")) { this.file = file; }
  append(trials) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const at = new Date().toISOString();
    fs.appendFileSync(this.file, trials.map((t) => JSON.stringify({ at, ...t })).join("\n") + "\n");
  }
  all() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  // Trials on the same instrument and timeframe compete with each other for the "best" slot.
  count(filter = {}) { return this.all().filter((t) => Object.entries(filter).every(([k, v]) => t[k] === v)).length; }
}
