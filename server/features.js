export const ALLOWED_METRIC_FIELDS = new Set([
  "total_views",
  "avg_views",
  "max_views",
  "total_likes",
  "total_comments",
  "total_shares",
  "video_count",
  "engagement_score",
  "engagement_rate",
  "share_rate",
  "originality_rate",
  "avg_duration_sec",
  "posting_span_days",
  "posting_consistency",
  "hashtag_diversity",
  "caption_word_avg",
  "caption_hashtags_avg",
  "caption_mentions_avg",
  "hit_rate",
  "breakout_video_ratio",
  "engagement_quality",
  "reach_percentile",
  "engagement_percentile",
  "consistency_score",
  "undiscovered_score",
  "promising_score"
]);

export const RAW_COLUMNS = [
  "views",
  "likes",
  "comments",
  "shares",
  "author_verified",
  "primary_hashtag",
  "music_name",
  "music_is_original",
  "duration_sec",
  "caption",
  "upload_date",
  "author_name",
  "video_id"
];

export const FEATURE_CATALOG = {
  engagement_quality:
    "Weighted engagement (likes + 3*comments + 5*shares) divided by views, as a percentile across creators.",
  reach_percentile: "A creator's total views compared with every other creator, as a percentile.",
  hit_rate: "Share of a creator's videos that beat the dataset's top-quartile views or engagement.",
  originality_rate: "Share of a creator's videos that use original music.",
  consistency_score: "Relative posting consistency across the observed upload dates.",
  total_views: "Sum of views across all of a creator's trending videos.",
  video_count: "Number of trending videos the creator has in this export.",
  share_rate: "Shares divided by views, a lightweight virality signal.",
  breakout_video_ratio: "A creator's top video views compared with their own average.",
  undiscovered_score: "Unverified creators with strong engagement quality and meaningful reach."
};

export const SIGNAL_FIELDS = Object.keys(FEATURE_CATALOG);

export const FILTERABLE_FIELDS = {
  is_verified: "1 for verified creators, 0 for unverified.",
  total_views: "Total views across the creator's videos.",
  video_count: "Number of trending videos.",
  total_shares: "Total shares across the creator's videos.",
  share_rate: "Shares divided by views.",
  engagement_rate: "Weighted engagement divided by views."
};

export const FEATURE_PRESETS = {
  promising: {
    label: "Promising",
    description:
      "Balanced mix of engagement quality, reach, repeat hits, originality, and consistency.",
    components: [
      { field: "engagement_quality", weight: 0.35 },
      { field: "reach_percentile", weight: 0.25 },
      { field: "hit_rate", weight: 0.2 },
      { field: "originality_rate", weight: 0.1 },
      { field: "consistency_score", weight: 0.1 }
    ]
  },
  breakout: {
    label: "Breakout",
    description: "Creators with standout peak videos and strong share behavior.",
    components: [
      { field: "breakout_video_ratio", weight: 0.45 },
      { field: "share_rate", weight: 0.3 },
      { field: "reach_percentile", weight: 0.25 }
    ]
  },
  undiscovered: {
    label: "Undiscovered",
    description: "Unverified creators with strong engagement quality and meaningful reach.",
    components: [
      { field: "engagement_quality", weight: 0.45 },
      { field: "reach_percentile", weight: 0.35 },
      { field: "hit_rate", weight: 0.2 }
    ],
    filters: [{ field: "is_verified", operator: "=", value: 0 }]
  }
};

// --- Genre classification (quick, keyword-based, no embeddings) -------------
// Topic lives only in hashtags + captions, which are heavily multilingual. We
// map specific keywords (mostly language-agnostic hashtags like #volleyball or
// #roblox) to a fixed, human-readable genre taxonomy. A creator can belong to
// several genres — we collect every genre their content touches.

// Discovery / reach spam that carries no topic meaning (many languages).
export const GENRE_STOPWORDS = new Set([
  "fyp", "fypシ", "fypage", "foryou", "foryoou", "foryoupage", "foryourpage", "fy", "fypツ",
  "viral", "viralvideo", "viralvideos", "trending", "trend", "trends", "tiktok", "tiktoks",
  "tiktokviral", "tik", "tok", "xyzbca", "xyzabc", "duet", "stitch", "capcut", "explore",
  "explorepage", "blowthisup", "blowup", "madewithtiktok", "pov", "voorjou", "voorjoupagina",
  "parati", "paratii", "pourtoi", "keşfet", "kesfet", "kesfetteyiz", "öneçıkar", "onecikar",
  "beniöneçıkar", "like", "likes", "comment", "comments", "follow", "followme", "share",
  "video", "videos", "challenge", "musically", "reels", "instagram", "insta", "youtube",
  "new", "love", "cute", "goals", "life", "me", "you", "the", "and", "original", "sound"
]);

// keyword -> genre. Keywords are matched as whole normalized tokens.
export const GENRE_LEXICON = {
  music: ["music", "song", "songs", "singing", "sing", "singer", "cover", "rap", "rapper", "hiphop", "guitar", "piano", "musician", "band", "lyrics", "remix", "dj", "beat", "beats", "producer", "karaoke", "melody", "vocals"],
  dance: ["dance", "dancing", "dancer", "choreography", "choreo", "ballet", "dancechallenge", "hiphopdance", "tanz", "baile", "dans"],
  comedy: ["comedy", "funny", "humor", "humour", "joke", "jokes", "meme", "memes", "prank", "lol", "laugh", "skit", "funnyvideos", "grappig", "mizah", "humo"],
  sports: ["sports", "sport", "football", "soccer", "volleyball", "basketball", "tennis", "baseball", "cricket", "skate", "skateboard", "surf", "surfing", "athlete", "goal", "nba", "nfl", "boxing", "mma", "golf", "rugby", "hockey", "voetbal"],
  gaming: ["game", "gaming", "gamer", "roblox", "minecraft", "fortnite", "valorant", "gta", "ps4", "ps5", "xbox", "twitch", "esports", "cod", "callofduty", "amongus", "leagueoflegends", "gameplay"],
  food: ["food", "cooking", "cook", "recipe", "recipes", "baking", "bake", "foodie", "chef", "kitchen", "eat", "eating", "mukbang", "dessert", "cake", "restaurant", "koken", "eten", "yemek"],
  fitness: ["fitness", "gym", "workout", "fit", "bodybuilding", "muscle", "abs", "weightloss", "fatloss", "gains", "training", "healthy", "yoga", "pilates", "fitdutch", "fitdutchie", "sportschool"],
  beauty: ["beauty", "makeup", "makeover", "skincare", "cosmetics", "lipstick", "nails", "hair", "hairstyle", "mua", "glam", "haircut"],
  fashion: ["fashion", "style", "outfit", "ootd", "clothes", "clothing", "dress", "streetwear", "model", "thrift", "mode"],
  education: ["education", "learn", "learning", "study", "school", "science", "math", "history", "facts", "diy", "howto", "tutorial", "tips", "lifehacks", "teacher", "les"],
  animals: ["animals", "animal", "dog", "dogs", "puppy", "cat", "cats", "pet", "pets", "kitten", "horse", "bird", "aquarium", "fish", "wildlife", "hond", "hund", "gato"],
  art: ["art", "drawing", "draw", "painting", "paint", "artist", "sketch", "craft", "crafts", "design", "tattoo", "kunst", "arte"],
  travel: ["travel", "traveling", "travelling", "trip", "vacation", "adventure", "nature", "wanderlust", "mountain", "beach", "reizen", "reisen"],
  family: ["family", "kids", "kid", "baby", "parenting", "parents", "mom", "dad", "mother", "father", "children", "toddler", "familie", "gezin"],
  cars: ["car", "cars", "auto", "automotive", "racing", "drift", "bmw", "audi", "mercedes", "motorcycle", "moto", "jdm", "supercar", "carsoftiktok"],
  lifestyle: ["vlog", "vlogs", "lifestyle", "daily", "routine", "grwm", "dayinmylife", "aesthetic", "motivation", "quotes", "dagelijks"]
};

export const GENRE_LIST = Object.keys(GENRE_LEXICON);

// Reverse index: token -> genre, for O(1) lookups during the single pass.
const TOKEN_TO_GENRE = (() => {
  const map = new Map();
  for (const [genre, keywords] of Object.entries(GENRE_LEXICON)) {
    for (const keyword of keywords) map.set(keyword, genre);
  }
  return map;
})();

// Lowercase, strip diacritics, keep alphanumerics. Turns "keşfet" -> "kesfet".
export function normalizeToken(raw) {
  return String(raw || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Given a creator's videos, return their genres ordered by how often the
// content touches each one. Uses hashtags (from captions + primary_hashtag)
// plus caption word tokens.
export function deriveGenres(videos) {
  const counts = new Map();

  for (const video of videos) {
    const tokens = new Set();

    if (video.primary_hashtag) tokens.add(normalizeToken(video.primary_hashtag));

    const caption = String(video.caption || "");
    for (const match of caption.matchAll(/#([^\s#]+)/g)) {
      tokens.add(normalizeToken(match[1]));
    }
    // Plain caption words (drop hashtags/mentions first).
    const plain = caption.replace(/[#@][^\s]+/g, " ");
    for (const word of plain.split(/\s+/)) {
      const token = normalizeToken(word);
      if (token.length >= 3) tokens.add(token);
    }

    for (const token of tokens) {
      if (!token || GENRE_STOPWORDS.has(token)) continue;
      const genre = TOKEN_TO_GENRE.get(token);
      if (genre) counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([genre]) => genre);
}

export function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function safeDivide(numerator, denominator) {
  const top = toNumber(numerator);
  const bottom = toNumber(denominator);
  return bottom === 0 ? 0 : top / bottom;
}

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value)));
}

export function countMatches(text, regex) {
  return (String(text || "").match(regex) || []).length;
}

export function captionWordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function percentileRanks(items, field) {
  const sorted = [...items]
    .map((item) => toNumber(item[field]))
    .sort((a, b) => a - b);

  return new Map(
    items.map((item) => {
      const value = toNumber(item[field]);
      const index = sorted.findIndex((candidate) => candidate >= value);
      const rank = sorted.length <= 1 ? 1 : index / (sorted.length - 1);
      return [item.author_name, clamp(rank)];
    })
  );
}

export function normalizeFeatureRecipe(recipe, selectedMetrics = []) {
  const recipeComponents = Array.isArray(recipe?.components) ? recipe.components : [];
  const chipComponents = !recipeComponents.length && Array.isArray(selectedMetrics)
    ? selectedMetrics.map((field) => ({ field, weight: 1 }))
    : [];

  const merged = new Map();
  for (const component of [...recipeComponents, ...chipComponents]) {
    if (!ALLOWED_METRIC_FIELDS.has(component.field)) {
      continue;
    }
    merged.set(component.field, (merged.get(component.field) || 0) + toNumber(component.weight, 1));
  }

  const components = [...merged.entries()]
    .map(([field, weight]) => ({ field, weight }))
    .filter((component) => ALLOWED_METRIC_FIELDS.has(component.field))
    .filter((component) => component.weight !== 0);

  if (!components.length) {
    return null;
  }

  const totalWeight = components.reduce((sum, component) => sum + Math.abs(component.weight), 0);
  return {
    label: recipe?.label || "Custom feature",
    description: recipe?.description || "User-selected weighted metrics.",
    components: components.map((component) => ({
      ...component,
      normalizedWeight: totalWeight ? component.weight / totalWeight : component.weight
    }))
  };
}

export function scoreCreator(creator, recipe) {
  const normalized = normalizeFeatureRecipe(recipe);
  if (!normalized) {
    return toNumber(creator.promising_score);
  }

  return normalized.components.reduce((score, component) => {
    return score + toNumber(creator[component.field]) * component.normalizedWeight;
  }, 0);
}
