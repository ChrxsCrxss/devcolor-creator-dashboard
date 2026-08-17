import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(DATA_DIR, "saved-rankings.json");

// Small JSON-file store for user-saved rankings. Rankings are recipes, not
// snapshots: we persist the label/description/signals/filters and recompute the
// creators against the live data whenever they're viewed, so At-a-glance always
// reflects the current dataset.
function readStore() {
  try {
    if (!existsSync(STORE_PATH)) return [];
    const raw = readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(rankings) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(rankings, null, 2));
}

export function listSavedRankings() {
  return readStore().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function addSavedRanking(recipe) {
  const rankings = readStore();
  const ranking = {
    id: `saved_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    label: recipe.label,
    description: recipe.description,
    components: recipe.components,
    filters: recipe.filters,
    genres: recipe.genres || [],
    createdAt: Date.now()
  };
  rankings.push(ranking);
  writeStore(rankings);
  return ranking;
}

export function removeSavedRanking(id) {
  const rankings = readStore();
  const next = rankings.filter((ranking) => ranking.id !== id);
  writeStore(next);
  return next.length !== rankings.length;
}
