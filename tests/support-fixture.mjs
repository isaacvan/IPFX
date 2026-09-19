// Shared test setup: builds the same knowledge object the Edge Function builds.
import fs from 'node:fs';
import { buildIndex } from '../supabase/functions/_shared/support-chat-core.js';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const seed = read('../supabase/seed/support_kb.json');
export const K = {
  presets: read('./fixtures/support-presets.json'),
  symbols: read('./fixtures/support-symbols.json'),
  cfg: Object.fromEntries(seed.config.map((c) => [c.key, c.value])),
  kb: seed.kb,
};
export const index = buildIndex(K.kb);
