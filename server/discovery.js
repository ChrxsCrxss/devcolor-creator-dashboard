import {
  ALLOWED_METRIC_FIELDS,
  FEATURE_CATALOG,
  FILTERABLE_FIELDS,
  GENRE_LIST,
  RAW_COLUMNS,
  SIGNAL_FIELDS,
  toNumber
} from "./features.js";

const GENRE_SET = new Set(GENRE_LIST);
import { generateJson, LLM_PROVIDER } from "./llm.js";

const FILTER_OPERATORS = new Set(["=", "!=", ">", ">=", "<", "<="]);
const DEFAULT_LIMIT = 25;

// Maps everyday language to the concrete signals we can actually rank on.
// Order matters: earlier fields win when keywords overlap (e.g. "views").
const SIGNAL_KEYWORDS = {
  share_rate: ["share", "shares", "shared", "sharing", "repost", "reposts", "reshare", "viral", "virality", "spread", "pass along"],
  engagement_quality: ["engage", "engagement", "engaging", "like", "likes", "comment", "comments", "interaction", "react", "reaction", "loyal", "fan", "fans", "fanbase", "community", "hardcore"],
  reach_percentile: ["reach", "popular", "popularity", "exposure", "impression", "impressions", "widely seen"],
  total_views: ["view", "views", "watch", "watched", "eyeballs"],
  video_count: ["prolific", "volume", "output", "how many videos", "number of videos", "frequent", "frequency", "post a lot"],
  consistency_score: ["consistent", "consistency", "steady", "regular", "regularly", "cadence", "routine"],
  originality_rate: ["original", "originality", "authentic", "creative", "own sound", "music", "sound", "audio"],
  breakout_video_ratio: ["breakout", "break out", "spike", "blow up", "blowing up", "surge", "outlier", "exploded", "took off"],
  hit_rate: ["hit", "hits", "repeat", "repeatable", "reliably", "batting average", "track record"],
  undiscovered_score: ["undiscovered", "underground", "hidden", "unknown", "emerging", "up and coming", "unverified", "small creator", "niche", "mainstream"]
};

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchSignals(text) {
  const found = [];
  for (const [field, words] of Object.entries(SIGNAL_KEYWORDS)) {
    const pattern = new RegExp(`\\b(${words.map(escapeRegex).join("|")})`, "i");
    if (pattern.test(text)) found.push(field);
  }
  return found;
}

function isCapabilityQuestion(lower) {
  return (
    /\b(do (we|you) have|do (we|you) track|is there|are there|have we got|can (we|you) (measure|track|see|use|rank)|feature for|signal for|metric for|column for|data (on|for|about)|what about|any (feature|signal|metric|data))\b/.test(
      lower
    ) || (/\?\s*$/.test(lower) && matchSignalsCount(lower) > 0 && lower.split(/\s+/).length <= 12)
  );
}

function matchSignalsCount(text) {
  return matchSignals(text).length;
}

// Direct, grounded answer to "do we have X?" style questions. The local model
// is too weak to answer these reliably, so we resolve them from the catalog.
function answerCapabilityQuestion(text, previousDraft) {
  const lower = text.toLowerCase();
  if (!isCapabilityQuestion(lower)) return null;

  const inDraft = new Set((previousDraft?.components || []).map((component) => component.field));
  const matched = matchSignals(lower);

  let message;
  let suggested;

  if (matched.length) {
    const named = matched
      .slice(0, 3)
      .map((field) => `"${field.replaceAll("_", " ")}" (${FEATURE_CATALOG[field]})`)
      .join("; ");
    const addable = matched.filter((field) => !inDraft.has(field));
    const already = matched.filter((field) => inDraft.has(field));

    message = `Yes. ${matched.length > 1 ? "These signals cover that" : "That maps to"}: ${named}.`;
    if (addable.length) {
      message += ` Want me to add ${addable.map((field) => field.replaceAll("_", " ")).join(" and ")} to the ranking?`;
    } else if (already.length) {
      message += ` It's already weighted in your current draft.`;
    }
    suggested = addable.length ? addable : matched;
  } else {
    const closest = ["engagement_quality", "share_rate", "reach_percentile"].filter(
      (field) => !inDraft.has(field)
    );
    message =
      "Not directly. This is video-level trending data, so there are no follower, demographic, or audience-identity signals. The closest proxies are " +
      closest.map((field) => field.replaceAll("_", " ")).join(", ") +
      ".";
    suggested = closest;
  }

  return baseProposal({
    message,
    readyToRun: false,
    clarifyingQuestions: [],
    suggestedSignals: suggested.slice(0, 4).map((field) => ({ field, description: FEATURE_CATALOG[field] })),
    draft: previousDraft || null,
    source: "grounded"
  });
}

// Suggestions should reflect what the user just said and exclude signals that
// are already in the draft, so the chips stop repeating the same three.
function contextualSuggestions(text, draft) {
  const inDraft = new Set((draft?.components || []).map((component) => component.field));
  const matched = matchSignals(text).filter((field) => !inDraft.has(field));

  let fields = matched;
  if (fields.length < 2) {
    const complements = SIGNAL_FIELDS.filter((field) => !inDraft.has(field) && !fields.includes(field));
    fields = [...fields, ...complements];
  }

  return fields.slice(0, 4).map((field) => ({ field, description: FEATURE_CATALOG[field] }));
}

// Tradeoff/scope questions that evolve with the draft, rather than repeating
// "how important are views" every turn.
function contextualQuestions(text, draft) {
  const inDraft = new Set((draft?.components || []).map((component) => component.field));
  const hasVerifiedFilter = (draft?.filters || []).some((filter) => filter.field === "is_verified");
  const pool = [];

  if (inDraft.has("reach_percentile") || inDraft.has("total_views")) {
    if (inDraft.has("engagement_quality")) {
      pool.push("Which matters more here: raw reach or engagement per view?");
    }
  }
  if (!hasVerifiedFilter) {
    pool.push("Should I limit this to unverified (undiscovered) creators?");
  }
  if (!inDraft.has("consistency_score") && !inDraft.has("video_count")) {
    pool.push("Does steady, repeat posting matter, or just peak performance?");
  }
  if (!inDraft.has("share_rate")) {
    pool.push("How much should shareability (shares per view) count?");
  }
  if (!inDraft.has("hit_rate")) {
    pool.push("Do you want repeat performers, or is one breakout hit enough?");
  }

  return pool.slice(0, 2);
}

const STARTER_PROMPTS = [
  "Creators with hardcore, high-engagement fanbases",
  "Undiscovered but growing fast",
  "Big reach, but audiences aren't resharing"
];

function isGreeting(lower) {
  return /^(hi+|hey+|hello+|yo+|sup|wass?up|was+up|hiya|heya|howdy|greetings|what'?s? ?up|what up|how'?s it going|hows it going|how are (you|ya)|how (you|ya) doin['g]?|good (morning|afternoon|evening)|g'?day)\b/.test(
    lower
  );
}

function isThanks(lower) {
  return /\b(thanks|thank you|thx|ty|cheers|appreciate it)\b/.test(lower);
}

function isMetaHelp(lower) {
  return /\b(help|what can you do|who are you|what (is|are) (this|you)|how does (this|it) work|what should i (ask|do)|where (do|should) i start)\b/.test(
    lower
  );
}

// Greetings, thanks, "what can you do", and single-word noise shouldn't be
// force-fit into a ranking. Orient the user with starter directions instead.
function smallTalkReply(clean, draft) {
  const lower = clean.toLowerCase();
  const hasSignal = matchSignals(lower).length > 0;
  const wordCount = lower.split(/\s+/).filter(Boolean).length;
  const greeting = isGreeting(lower);
  const thanks = isThanks(lower);
  const meta = isMetaHelp(lower);
  const contentless = !hasSignal && wordCount <= 1;

  if (!greeting && !thanks && !meta && !contentless) return null;
  // "hey, show me viral creators" carries a real goal — let it through.
  if (hasSignal && !thanks) return null;

  let message;
  if (thanks) {
    message =
      "Anytime. Want to explore another angle? Describe the kind of creators you're after and I'll shape a ranking.";
  } else if (meta) {
    message =
      "I turn fuzzy creator strategy into concrete rankings. Tell me who you're trying to find and I'll map it to signals this data actually has — reach, engagement per view, shareability, consistency, breakout hits, originality — propose a weighted ranking, and ask questions to sharpen it. Nothing runs until you hit Run.";
  } else {
    message =
      "Hey — I'm your analytics engineer for this TikTok trending dataset. Tell me what kind of creators you're looking for (even a vague idea) and I'll translate it into a concrete, weighted ranking you can run and save.";
  }

  return baseProposal({
    message,
    readyToRun: false,
    clarifyingQuestions: STARTER_PROMPTS,
    suggestedSignals: [],
    draft: draft || null,
    source: "grounded"
  });
}

/**
 * Discovery turn: the model acts as an analytics engineer. It proposes a draft
 * ranking, asks follow-ups, and suggests signals. It NEVER executes a query.
 */
export async function discuss({ question, history = [], draft = null }) {
  const clean = String(question || "").trim();
  if (!clean) {
    return baseProposal({
      message:
        "Tell me what kind of creators you're after. Even a fuzzy idea works, like \"undiscovered but growing fast\" or \"safe, high-reach names.\"",
      readyToRun: false
    });
  }

  // Greetings / small talk / contentless input: orient, don't fabricate a draft.
  const smallTalk = smallTalkReply(clean, draft);
  if (smallTalk) return smallTalk;

  // Answer direct dataset questions ("do we have shares?") deterministically.
  const capability = answerCapabilityQuestion(clean, draft);
  if (capability) return capability;

  try {
    const raw = await generateJson(buildDiscoveryPrompt(clean, history, draft));
    return validateProposal(raw, clean, draft, LLM_PROVIDER);
  } catch (error) {
    return fallbackProposal(clean, draft, { llmError: error.message });
  }
}

// Human-readable snapshot of what the user currently has on the dashboard, so
// the model treats it as the user's standing intent and builds on it.
function describeDashboardState(draft) {
  if (!draft) return "The dashboard is empty — no signals, filters, or genres selected yet.";

  const components = validateComponents(draft.components);
  const filters = validateFilters(draft.filters);
  const genres = validateGenres(draft.genres);

  if (!components.length && !filters.length && !genres.length) {
    return "The dashboard is empty — no signals, filters, or genres selected yet.";
  }

  const lines = [];
  if (components.length) {
    lines.push(
      `Signals: ${components
        .map((c) => `${c.field} (weight ${c.weight}${c.weight < 0 ? ", inverted/lower-is-better" : ""})`)
        .join(", ")}`
    );
  } else {
    lines.push("Signals: none yet (would rank by default promising score)");
  }
  if (filters.length) {
    lines.push(`Filters: ${filters.map((f) => `${f.field} ${f.operator} ${f.value}`).join(", ")}`);
  }
  if (genres.length) lines.push(`Genres: ${genres.join(", ")}`);
  return lines.join("\n");
}

function buildDiscoveryPrompt(question, history, draft) {
  const signalLines = SIGNAL_FIELDS.map((field) => `- ${field}: ${FEATURE_CATALOG[field]}`).join("\n");
  const filterLines = Object.entries(FILTERABLE_FIELDS)
    .map(([field, description]) => `- ${field}: ${description}`)
    .join("\n");
  const historyText = history
    .slice(-8)
    .map((message) => `${message.role === "user" ? "User" : "You"}: ${message.text}`)
    .join("\n");

  return `
You are a senior analytics engineer helping a busy, non-technical Head of Creator Partnerships explore a TikTok trending-video dataset. You are collaborative and concise, like a smart colleague. You NEVER write SQL. You translate fuzzy goals into a weighted blend of pre-built signals.

The dataset is ~1000 trending videos, ~800 creators. There are no follower counts or demographics. "Reach" means views.

Raw columns available: ${RAW_COLUMNS.join(", ")}.

The ONLY signals you can rank with (use these exact field names):
${signalLines}

Filters you can apply:
${filterLines}

Genres you can filter by (topic tags derived from hashtags/captions): ${GENRE_LIST.join(", ")}.

Your job is to TRANSLATE a vague human goal into concrete signals, and to teach the user how you did it so they can steer.

Weights are signed and range from -1 to 1. A POSITIVE weight rewards higher values of a signal; a NEGATIVE weight penalizes them (ranks that signal ascending / "lower is better"). Use a negative weight when the user wants the OPPOSITE of a signal. Example: "big creators whose audiences AREN'T resharing" = positive reach_percentile/total_views + a NEGATIVE share_rate (e.g. -0.3). The magnitudes (absolute values) should sum to about 1.

How to behave:
- If the user is just greeting you or making small talk (e.g. "hey", "what's up", "thanks") with no creator-discovery intent, reply warmly in one line, invite them to describe who they're looking for, and return an EMPTY "components" array. Do NOT invent a ranking.
- If the user asks a direct question (e.g. "do we have a feature for shares?"), ANSWER IT FIRST and specifically, naming the exact signal(s).
- Otherwise, INTERPRET their fuzzy phrase, then explain the mapping: name each signal you put in the draft AND why it fits, quoting the signal's plain definition. Example: "'Breakout potential' means a standout moment relative to a creator's own norm, so I'm leaning on breakout video ratio (top video vs. their average) and hit rate (how often they beat the top quartile), so it isn't a one-off fluke."
- Your "message" MUST name every signal that appears in your draft, in plain words, and explicitly call out any signal you are penalizing (negative weight) and why. Never describe signals that are not in the draft, and never omit ones that are. The message and the draft must agree.
- Format "message" with light markdown: a one-sentence interpretation, then a short bullet list (one bullet per signal) with the **signal name in bold** and a plain-English why. Keep it tight.
- Then ask exactly ONE sharp question that resolves a real tradeoff for THIS goal (e.g. "one giant hit, or repeat performers?"), not a generic one.
- If the data can't directly measure something (loyalty, fandom, demographics, sentiment), say so plainly and name the closest proxy signals.
- Do NOT begin with "To summarize" or "To identify". Do not repeat yourself across turns.
- Only set readyToRun to true once the draft clearly matches their intent.
- Keep "message" concise: one interpretation sentence + the bullet mapping. No filler, no "To summarize".

IMPORTANT — build on the current dashboard state below. The user may have already set signals, filters, or genres themselves. Treat that as their standing intent: ADD to or ADJUST it rather than starting over. Always echo back their existing filters and genres in your draft UNLESS the user explicitly asks to change or remove them. You may also add a "genres" array (from the list above) when the user's goal clearly implies a topic.

Return ONLY JSON in this shape:
{
  "message": "Interpretation of their goal, then which signals map to it and why (quoting definitions).",
  "readyToRun": false,
  "clarifyingQuestions": ["one sharp tradeoff question for this goal"],
  "suggestedSignals": ["share_rate", "engagement_quality"],
  "draft": {
    "label": "Short name for this ranking",
    "description": "One plain sentence on what this captures and why these signals",
    "components": [{ "field": "share_rate", "weight": 0.5 }],
    "filters": [{ "field": "is_verified", "operator": "=", "value": 0 }],
    "genres": ["gaming"]
  }
}

Current dashboard state:
${describeDashboardState(draft)}
${historyText ? `Conversation so far:\n${historyText}` : ""}
User: ${question}
`;
}

function validateProposal(raw, question, previousDraft, source) {
  const components = validateComponents(raw?.draft?.components);
  // The user's own filters/genres are their standing intent. If the model
  // explicitly returns a filters/genres array (even empty, e.g. to remove one),
  // honor it; if it omits the key entirely, carry the user's forward.
  const carriedFilters = validateFilters(previousDraft?.filters);
  const carriedGenres = validateGenres(previousDraft?.genres);
  const filters = Array.isArray(raw?.draft?.filters)
    ? validateFilters(raw.draft.filters)
    : carriedFilters;
  const genres = Array.isArray(raw?.draft?.genres)
    ? validateGenres(raw.draft.genres)
    : carriedGenres;

  let draft = null;

  if (components.length) {
    // Model proposed concrete signals — use them.
    draft = {
      label: cleanText(raw?.draft?.label, "Custom ranking", 60),
      description: cleanText(raw?.draft?.description, "Weighted blend of signals.", 200),
      components,
      filters,
      genres
    };
  } else if (matchSignals(question).length > 0) {
    // The message reads like a goal but the model didn't structure it — fall
    // back to a sensible starting point so the user still gets a draft.
    const fallback = fallbackDraft(question, previousDraft);
    draft = {
      label: cleanText(raw?.draft?.label, fallback.label || "Custom ranking", 60),
      description: cleanText(raw?.draft?.description, fallback.description || "Weighted blend of signals.", 200),
      components: fallback.components,
      filters: fallback.filters?.length ? fallback.filters : filters,
      genres
    };
  } else if (previousDraft?.components?.length || carriedGenres.length || carriedFilters.length) {
    // No new goal this turn — keep whatever the user already has on the board.
    draft = {
      label: previousDraft?.label || "Custom ranking",
      description: previousDraft?.description || "Weighted blend of signals.",
      components: validateComponents(previousDraft?.components),
      filters: carriedFilters,
      genres: carriedGenres
    };
  }
  // Otherwise this is a conversational turn (greeting, small talk, meta): leave
  // draft null so we don't fabricate a ranking the user never asked for.

  if (!draft) {
    return baseProposal({
      message: cleanText(
        raw?.message,
        "Tell me what kind of creators you're after and I'll shape a ranking.",
        600
      ),
      readyToRun: false,
      clarifyingQuestions: Array.isArray(raw?.clarifyingQuestions)
        ? raw.clarifyingQuestions.filter((item) => typeof item === "string").slice(0, 3)
        : STARTER_PROMPTS,
      suggestedSignals: [],
      draft: null,
      source
    });
  }

  return baseProposal({
    message: groundedMessage(
      cleanText(raw?.message, "", 600),
      question,
      draft
    ),
    readyToRun: Boolean(raw?.readyToRun),
    clarifyingQuestions: contextualQuestions(question, draft),
    suggestedSignals: contextualSuggestions(question, draft),
    draft,
    source
  });
}

// Keep the chat message honest about the draft. A capable model writes its own
// grounded explanation, which we keep. We only override when the message is
// missing or clearly disconnected from the draft (references none of its
// signals) — the failure mode seen with weaker models.
function groundedMessage(modelMessage, question, draft) {
  const components = [...(draft?.components || [])].sort(
    (a, b) => Math.abs(b.weight) - Math.abs(a.weight)
  );
  if (!components.length) return modelMessage || "Tell me more about what you're looking for.";

  const referencesAny = components.some((component) => mentionsSignal(modelMessage, component.field));
  if (modelMessage && referencesAny) return modelMessage;

  const goal = question.trim().replace(/[.?!]+$/, "");
  const named = components.map((component) => {
    const name = component.field.replaceAll("_", " ");
    return component.weight < 0 ? `${name} (penalized)` : name;
  });
  const mapping = components
    .slice(0, 3)
    .map((component) => {
      const name = component.field.replaceAll("_", " ");
      const def = FEATURE_CATALOG[component.field];
      return component.weight < 0
        ? `${name} run in reverse to favor low values (${def})`
        : `${name} (${def})`;
    })
    .join("; ");

  return `I'm reading "${goal}" as a blend of ${listPhrase(named)}. Concretely that means ${mapping}. Tell me which of these should carry the most weight.`;
}

// Loose check: does the message reference this signal by its readable name or
// its leading keyword (so "engagement" counts for "engagement quality")?
function mentionsSignal(message, field) {
  const lower = (message || "").toLowerCase();
  const readable = field.replaceAll("_", " ");
  if (lower.includes(readable)) return true;
  const firstWord = readable.split(" ")[0];
  return firstWord.length >= 3 && lower.includes(firstWord);
}

function listPhrase(items) {
  if (items.length <= 1) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function buildRationale(draft) {
  return (draft?.components || []).map((component) => ({
    field: component.field,
    label: component.field.replaceAll("_", " "),
    definition: FEATURE_CATALOG[component.field] || "",
    weight: component.weight
  }));
}

function fallbackProposal(question, previousDraft, meta = {}) {
  const draft = fallbackDraft(question, previousDraft);
  // Preserve the user's dashboard genres and any filters they set.
  const carriedGenres = validateGenres(previousDraft?.genres);
  if (carriedGenres.length) draft.genres = carriedGenres;
  if (!draft.filters?.length) {
    const carriedFilters = validateFilters(previousDraft?.filters);
    if (carriedFilters.length) draft.filters = carriedFilters;
  }
  const lower = question.toLowerCase();
  const unsupported = detectUnsupported(lower);

  const message = unsupported
    ? `This dataset can't directly measure ${unsupported}. The closest proxy is ${draft.components
        .map((component) => `${component.field.replaceAll("_", " ")} (${FEATURE_CATALOG[component.field]})`)
        .join("; ")}. Want me to run that, or adjust the mix?`
    : groundedMessage("", question, draft);

  return baseProposal({
    message,
    readyToRun: false,
    clarifyingQuestions: contextualQuestions(question, draft),
    suggestedSignals: contextualSuggestions(question, draft),
    draft,
    source: "fallback",
    ...meta
  });
}

function baseProposal(partial) {
  return {
    type: "proposal",
    message: partial.message || "",
    readyToRun: Boolean(partial.readyToRun),
    clarifyingQuestions: partial.clarifyingQuestions || [],
    suggestedSignals: partial.suggestedSignals || [],
    draft: partial.draft || null,
    rationale: partial.draft ? buildRationale(partial.draft) : [],
    source: partial.source || "validator",
    interpretedAs: partial.draft ? describeDraft(partial.draft) : null,
    ...(partial.llmError ? { llmError: partial.llmError } : {})
  };
}

/**
 * Build an executable plan from a confirmed draft.
 */
export function buildRunPlan(draft) {
  const components = validateComponents(draft?.components);
  const filters = validateFilters(draft?.filters);
  const genres = validateGenres(draft?.genres);
  const label = cleanText(draft?.label, "Custom ranking", 60);
  const description = cleanText(draft?.description, "Weighted blend of signals.", 200);

  const featureRecipe = components.length
    ? { label, description, components }
    : null;

  return {
    intent: "custom",
    featureRecipe,
    filters,
    genres,
    selectedMetrics: [],
    limit: DEFAULT_LIMIT,
    label,
    interpretedAs: describeDraft({ label, description, components, filters, genres })
  };
}

function validateGenres(genres) {
  if (!Array.isArray(genres)) return [];
  return [...new Set(genres.filter((genre) => GENRE_SET.has(genre)))].slice(0, 8);
}

function validateComponents(components) {
  if (!Array.isArray(components)) return [];
  const merged = new Map();
  for (const component of components) {
    if (!ALLOWED_METRIC_FIELDS.has(component?.field)) continue;
    const weight = clampWeight(component.weight);
    if (weight === 0) continue;
    merged.set(component.field, weight);
  }
  return [...merged.entries()].slice(0, 6).map(([field, weight]) => ({ field, weight }));
}

function validateFilters(filters) {
  if (!Array.isArray(filters)) return [];
  return filters
    .filter(
      (filter) =>
        filter &&
        Object.prototype.hasOwnProperty.call(FILTERABLE_FIELDS, filter.field) &&
        FILTER_OPERATORS.has(filter.operator) &&
        filter.value !== undefined &&
        filter.value !== null
    )
    .map((filter) => ({
      field: filter.field,
      operator: filter.operator,
      value: filter.field === "is_verified" ? (toNumber(filter.value) ? 1 : 0) : toNumber(filter.value)
    }))
    .slice(0, 4);
}

function fallbackDraft(question, previousDraft) {
  const lower = question.toLowerCase();
  const carried = validateComponents(previousDraft?.components);
  const carriedFilters = validateFilters(previousDraft?.filters);

  if (/\b(prolific|most videos|volume|frequent|consistent|steady)\b/.test(lower)) {
    return draftFrom("Prolific & consistent", "Creators who post repeatedly and show up often.", [
      { field: "video_count", weight: 0.6 },
      { field: "consistency_score", weight: 0.4 }
    ]);
  }
  // "big creators whose audience ISN'T sharing" — reward reach, penalize shares.
  if (
    /\b(not|isn'?t|aren'?t|without|low|no)\b[^.?!]*\b(shar|viral|reshar|spread|pass)/.test(lower) ||
    /\b(shar|viral|reshar|spread)[^.?!]*\b(not|isn'?t|aren'?t|low|little)\b/.test(lower)
  ) {
    return draftFrom(
      "Big reach, low sharing",
      "Large creators whose audiences don't reshare their content.",
      [
        { field: "reach_percentile", weight: 0.4 },
        { field: "total_views", weight: 0.3 },
        { field: "share_rate", weight: -0.3 }
      ]
    );
  }
  if (/\b(viral|shares|shareable|spread)\b/.test(lower)) {
    return draftFrom("Viral spread", "Content people actively pass along.", [
      { field: "share_rate", weight: 0.6 },
      { field: "reach_percentile", weight: 0.4 }
    ]);
  }
  if (/\b(undiscovered|underground|unverified|hidden|niche|small)\b/.test(lower)) {
    return {
      label: "Undiscovered talent",
      description: "Unverified creators with strong engagement quality and reach.",
      components: [
        { field: "engagement_quality", weight: 0.45 },
        { field: "reach_percentile", weight: 0.35 },
        { field: "hit_rate", weight: 0.2 }
      ],
      filters: [{ field: "is_verified", operator: "=", value: 0 }]
    };
  }
  if (/\b(reach|popular|views|biggest|famous)\b/.test(lower)) {
    return draftFrom("Greatest reach", "Total views across trending videos.", [
      { field: "reach_percentile", weight: 0.7 },
      { field: "total_views", weight: 0.3 }
    ]);
  }
  if (/\b(engage|engaging|likes|comments|loyal|fan|fanbase|hardcore|community)\b/.test(lower)) {
    return draftFrom(
      "High engagement",
      "Audiences that react strongly relative to reach.",
      [
        { field: "engagement_quality", weight: 0.6 },
        { field: "share_rate", weight: 0.4 }
      ]
    );
  }
  if (/\b(breakout|spike|surprise|blowing up|growing)\b/.test(lower)) {
    return draftFrom("Breakout", "Creators with a standout video vs their own baseline.", [
      { field: "breakout_video_ratio", weight: 0.5 },
      { field: "share_rate", weight: 0.3 },
      { field: "reach_percentile", weight: 0.2 }
    ]);
  }
  if (/\b(original|music|sound|creative|authentic|cultural|culture|relevant|tastemaker)\b/.test(lower)) {
    return draftFrom(
      "Original & culturally relevant",
      "Original sounds plus content that travels through a niche.",
      [
        { field: "originality_rate", weight: 0.4 },
        { field: "share_rate", weight: 0.35 },
        { field: "hashtag_diversity", weight: 0.25 }
      ]
    );
  }

  if (carried.length) {
    return {
      label: cleanText(previousDraft?.label, "Custom ranking", 60),
      description: cleanText(previousDraft?.description, "Weighted blend of signals.", 200),
      components: carried,
      filters: carriedFilters
    };
  }

  return {
    label: "Promising creators",
    description: "Balanced blend of engagement, reach, repeat hits, and consistency.",
    components: [
      { field: "engagement_quality", weight: 0.35 },
      { field: "reach_percentile", weight: 0.25 },
      { field: "hit_rate", weight: 0.2 },
      { field: "consistency_score", weight: 0.2 }
    ],
    filters: []
  };
}

function draftFrom(label, description, components) {
  return { label, description, components, filters: [] };
}

function detectUnsupported(lower) {
  if (/\b(fan ?base|hardcore fan|loyal|loyalty|superfan|community)\b/.test(lower)) {
    return "fan loyalty directly (there are no follower or repeat-viewer signals)";
  }
  if (/\b(demographic|age|gender|location|country|audience)\b/.test(lower)) {
    return "audience demographics";
  }
  if (/\b(sentiment|positive|negative|vibe|mood)\b/.test(lower)) {
    return "comment sentiment";
  }
  if (/\b(cultural|culture|relevant|tastemaker|aesthetic)\b/.test(lower)) {
    return "cultural relevance directly";
  }
  return null;
}

function describeDraft(draft) {
  const parts = draft.components.map((component) => {
    const name = component.field.replaceAll("_", " ");
    const magnitude = Math.abs(component.weight);
    return component.weight < 0
      ? `${name} (${magnitude}, lower is better)`
      : `${name} (${magnitude})`;
  });
  const filterText = draft.filters?.length
    ? ` Filtered to ${draft.filters
        .map((filter) => `${filter.field.replaceAll("_", " ")} ${filter.operator} ${filter.value}`)
        .join(", ")}.`
    : "";
  const genreText = draft.genres?.length ? ` Genres: ${draft.genres.join(", ")}.` : "";
  const basis = parts.length
    ? `weighted percentile blend of ${parts.join(", ")}`
    : "default promising-creator score";
  return `"${draft.label}": ${basis}.${filterText}${genreText}`;
}

// Weights are signed: a positive weight rewards higher values of a signal, a
// negative weight penalizes them (i.e. ranks the signal ascending). Magnitude
// is capped at 1 in either direction.
function clampWeight(weight) {
  const numeric = toNumber(weight, 0);
  return Math.min(1, Math.max(-1, Math.round(numeric * 100) / 100));
}

function cleanText(value, fallback, maxLength) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
