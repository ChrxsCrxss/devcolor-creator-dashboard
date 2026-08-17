import "dotenv/config";
import express from "express";
import cors from "cors";
import { createDatabase } from "./data.js";
import { FEATURE_PRESETS } from "./features.js";
import { checkLlm } from "./llm.js";
import { buildRunPlan, discuss } from "./discovery.js";
import { getCreatorVideos, getGenreFacets, getSummary, INTENT_CONFIG, rankCreators } from "./queryRunner.js";
import { addSavedRanking, listSavedRankings, removeSavedRanking } from "./savedRankings.js";

const PORT = process.env.PORT || 5174;
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const state = {
  db: null,
  stats: null,
  startupError: null
};

createDatabase()
  .then(({ db, stats }) => {
    state.db = db;
    state.stats = stats;
    app.listen(PORT, () => {
      console.log(`Creator dashboard API listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    state.startupError = error;
    console.error("Failed to initialize data:", error);
    process.exitCode = 1;
  });

app.get("/api/health", async (_request, response) => {
  const llm = await checkLlm();
  response.json({
    ok: Boolean(state.db) && !state.startupError,
    data: state.stats,
    llm,
    note: llm.note
  });
});

app.get("/api/features", (_request, response) => {
  response.json({
    presets: FEATURE_PRESETS,
    intents: INTENT_CONFIG
  });
});

app.get("/api/summary", requireDb, (_request, response) => {
  response.json({
    stats: state.stats,
    caveats: caveats(),
    sections: getSummary(state.db),
    genres: getGenreFacets(state.db)
  });
});

app.get("/api/rankings", requireDb, (_request, response) => {
  response.json({ rankings: buildSavedSections() });
});

app.post("/api/rankings", requireDb, (request, response) => {
  const plan = buildRunPlan(request.body.draft);
  const hasContent =
    plan.featureRecipe?.components?.length || plan.genres?.length || plan.filters?.length;
  if (!hasContent) {
    response.status(400).json({ error: "Add a signal, genre, or filter before saving." });
    return;
  }
  const draft = request.body.draft || {};
  const saved = addSavedRanking({
    label: plan.label,
    description: draft.description || plan.featureRecipe?.description || "Filtered ranking.",
    components: plan.featureRecipe?.components || [],
    filters: plan.filters,
    genres: plan.genres
  });
  response.status(201).json({ ranking: withResults(saved) });
});

app.delete("/api/rankings/:id", requireDb, (request, response) => {
  const removed = removeSavedRanking(request.params.id);
  response.json({ removed });
});

app.get("/api/creators/:authorName/videos", requireDb, (request, response) => {
  response.json({
    author_name: request.params.authorName,
    videos: getCreatorVideos(state.db, request.params.authorName)
  });
});

app.post("/api/ask", requireDb, async (request, response, next) => {
  try {
    const action = request.body.action === "run" ? "run" : "discuss";

    if (action === "run") {
      const plan = buildRunPlan(request.body.draft);
      const creators = rankCreators(state.db, plan);
      response.json({
        type: "answer",
        plan,
        interpretedAs: plan.interpretedAs,
        answer: buildAnswer(plan, creators),
        caveats: caveats(),
        creators
      });
      return;
    }

    const proposal = await discuss({
      question: request.body.question,
      history: request.body.history,
      draft: request.body.draft
    });
    response.json({ ...proposal, caveats: caveats() });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({
    error: "Something went wrong while answering that question.",
    detail: process.env.NODE_ENV === "production" ? undefined : error.message
  });
});

function requireDb(_request, response, next) {
  if (!state.db) {
    response.status(503).json({ error: "Data is still loading or failed to initialize." });
    return;
  }
  next();
}

function buildSavedSections() {
  return listSavedRankings().map(withResults);
}

// Recompute a saved recipe against the live data so At-a-glance stays current.
function withResults(saved) {
  const plan = buildRunPlan({
    label: saved.label,
    description: saved.description,
    components: saved.components,
    filters: saved.filters,
    genres: saved.genres
  });
  return {
    id: saved.id,
    key: saved.id,
    title: saved.label,
    definition: saved.description,
    interpretedAs: plan.interpretedAs,
    createdAt: saved.createdAt,
    saved: true,
    creators: rankCreators(state.db, plan)
  };
}

function buildAnswer(plan, creators) {
  if (!creators.length) {
    return "I could not find creators matching those criteria in this dataset.";
  }

  const top = creators[0];
  const runnerUp =
    creators
      .slice(1, 3)
      .map((creator) => creator.author_name)
      .join(", ") || "no close second";
  return `Done. ${top.author_name} leads, followed by ${runnerUp}. This uses ${plan.interpretedAs}`;
}

function caveats() {
  return [
    "This CSV has video-level trending data, not follower counts or audience demographics.",
    "Reach means views in this dataset.",
    "LLM output is only used to choose validated intents, fields, filters, and feature weights. SQL is generated from server-owned templates."
  ];
}
