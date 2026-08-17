import { ALLOWED_METRIC_FIELDS, GENRE_LIST, normalizeFeatureRecipe, toNumber } from "./features.js";

const GENRE_SET = new Set(GENRE_LIST);

const SORT_FIELDS = new Set([...ALLOWED_METRIC_FIELDS, "author_name"]);
const FILTER_FIELDS = new Set([...ALLOWED_METRIC_FIELDS, "is_verified", "top_hashtag"]);
const OPERATORS = new Set(["=", "!=", ">", ">=", "<", "<=", "contains"]);

export const INTENT_CONFIG = {
  promising: {
    label: "Promising creators",
    sort: "promising_score",
    definition:
      "balanced score using engagement quality, reach, repeat hit rate, originality, and posting consistency"
  },
  engagement: {
    label: "Most engaging creators",
    sort: "engagement_score",
    definition: "likes, comments, and shares weighted more heavily than views"
  },
  reach: {
    label: "Greatest reach",
    sort: "total_views",
    definition: "total views across videos in this trending dataset"
  },
  prolific: {
    label: "Most prolific creators",
    sort: "video_count",
    definition: "number of trending videos in the dataset"
  },
  viral: {
    label: "Most viral creators",
    sort: "total_shares",
    definition: "shares and share rate as a proxy for viral spread"
  },
  undiscovered: {
    label: "Undiscovered high-potential creators",
    sort: "undiscovered_score",
    definition: "unverified creators with strong engagement quality and meaningful reach",
    filters: [{ field: "is_verified", operator: "=", value: 0 }]
  },
  original: {
    label: "Most original creators",
    sort: "originality_rate",
    definition: "share of videos using original music"
  },
  consistent: {
    label: "Most consistent creators",
    sort: "consistency_score",
    definition: "repeat posting in this dataset across the observed date range"
  },
  breakout: {
    label: "Breakout creators",
    sort: "breakout_video_ratio",
    definition: "creators whose top video sharply outperforms their own average"
  }
};

export function rankCreators(db, plan) {
  const limit = clampLimit(plan.limit);
  const filters = [...(INTENT_CONFIG[plan.intent]?.filters || []), ...(plan.filters || [])].filter(
    isValidFilter
  );
  const where = buildWhere(filters);
  const genre = buildGenreClause(plan.genres);
  const whereSql = mergeWhere(where.sql, genre.sql);
  const params = [...where.params, ...genre.params];

  if (plan.intent === "custom" || plan.featureRecipe) {
    const rows = selectCreators(db, whereSql, params, 250);
    const recipe = normalizeFeatureRecipe(plan.featureRecipe, plan.selectedMetrics);
    return scoreCreatorsWithPercentiles(rows, recipe)
      .sort((a, b) => b.custom_score - a.custom_score)
      .slice(0, limit)
      .map((creator) => formatCreator(creator, plan));
  }

  const config = INTENT_CONFIG[plan.intent] || INTENT_CONFIG.promising;
  const sort = SORT_FIELDS.has(plan.sort) ? plan.sort : config.sort;
  const rows = queryRows(
    db,
    `
      SELECT *
      FROM creator_metrics
      ${whereSql}
      ORDER BY ${sort} DESC, total_views DESC
      LIMIT ?
    `,
    [...params, limit]
  );

  return rows.map((creator) => formatCreator(creator, { ...plan, sort }));
}

// Returns [{ genre, count }] for every genre present in the data, so the client
// can offer a searchable multi-select.
export function getGenreFacets(db) {
  const rows = queryRows(db, "SELECT genres FROM creator_metrics WHERE genres IS NOT NULL AND genres != ''");
  const counts = new Map();
  for (const row of rows) {
    for (const genre of String(row.genres).split("|").filter(Boolean)) {
      counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  }
  return GENRE_LIST.filter((genre) => counts.has(genre))
    .map((genre) => ({ genre, count: counts.get(genre) }))
    .sort((a, b) => b.count - a.count);
}

function validGenres(genres) {
  if (!Array.isArray(genres)) return [];
  return [...new Set(genres.filter((genre) => GENRE_SET.has(genre)))].slice(0, 8);
}

// Match creators tagged with ANY of the selected genres (OR).
function buildGenreClause(genres) {
  const valid = validGenres(genres);
  if (!valid.length) return { sql: "", params: [] };
  return {
    sql: `(${valid.map(() => "genres LIKE ?").join(" OR ")})`,
    params: valid.map((genre) => `%|${genre}|%`)
  };
}

function mergeWhere(base, extra) {
  if (base && extra) return `${base} AND ${extra}`;
  if (base) return base;
  if (extra) return `WHERE ${extra}`;
  return "";
}

export function getSummary(db) {
  const sections = [
    { key: "promising", plan: { intent: "promising", limit: 25 } },
    { key: "undiscovered", plan: { intent: "undiscovered", limit: 25 } },
    { key: "engagement", plan: { intent: "engagement", limit: 25 } },
    { key: "viral", plan: { intent: "viral", limit: 25 } },
    { key: "prolific", plan: { intent: "prolific", limit: 25 } }
  ];

  return sections.map((section) => ({
    key: section.key,
    title: INTENT_CONFIG[section.plan.intent].label,
    definition: INTENT_CONFIG[section.plan.intent].definition,
    creators: rankCreators(db, section.plan)
  }));
}

export function getCreatorVideos(db, authorName) {
  return queryRows(
    db,
    `
      SELECT
        video_id,
        author_name,
        views,
        likes,
        comments,
        shares,
        author_verified,
        primary_hashtag,
        music_name,
        music_is_original,
        duration_sec,
        caption,
        upload_date
      FROM videos
      WHERE author_name = ?
      ORDER BY views DESC, likes DESC
      LIMIT 100
    `,
    [authorName]
  ).map((video) => ({
    ...video,
    views: toNumber(video.views),
    likes: toNumber(video.likes),
    comments: toNumber(video.comments),
    shares: toNumber(video.shares),
    author_verified: Boolean(video.author_verified),
    music_is_original: Boolean(video.music_is_original),
    duration_sec: toNumber(video.duration_sec)
  }));
}

export function queryRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  return rows;
}

function selectCreators(db, whereSql, params, limit) {
  return queryRows(
    db,
    `
      SELECT *
      FROM creator_metrics
      ${whereSql}
      ORDER BY total_views DESC
      LIMIT ?
    `,
    [...params, limit]
  );
}

function scoreCreatorsWithPercentiles(creators, recipe) {
  const normalizedRecipe = normalizeFeatureRecipe(recipe);
  if (!normalizedRecipe) {
    return creators.map((creator) => ({ ...creator, custom_score: toNumber(creator.promising_score) }));
  }

  const percentileMaps = new Map(
    normalizedRecipe.components.map((component) => [
      component.field,
      percentileMap(creators, component.field)
    ])
  );

  return creators.map((creator) => {
    const customScore = normalizedRecipe.components.reduce((score, component) => {
      const percentile = percentileMaps.get(component.field)?.get(creator.author_name) || 0;
      return score + percentile * component.normalizedWeight;
    }, 0);

    return { ...creator, custom_score: customScore };
  });
}

function percentileMap(creators, field) {
  const sorted = creators.map((creator) => toNumber(creator[field])).sort((a, b) => a - b);

  return new Map(
    creators.map((creator) => {
      const value = toNumber(creator[field]);
      const firstIndex = sorted.findIndex((candidate) => candidate >= value);
      const percentile = sorted.length <= 1 ? 1 : firstIndex / (sorted.length - 1);
      return [creator.author_name, percentile];
    })
  );
}

function buildWhere(filters) {
  const clauses = [];
  const params = [];

  for (const filter of filters) {
    if (filter.operator === "contains") {
      clauses.push(`${filter.field} LIKE ?`);
      params.push(`%${String(filter.value || "")}%`);
      continue;
    }
    clauses.push(`${filter.field} ${filter.operator} ?`);
    params.push(filter.value);
  }

  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function isValidFilter(filter) {
  return (
    filter &&
    FILTER_FIELDS.has(filter.field) &&
    OPERATORS.has(filter.operator) &&
    filter.value !== undefined &&
    filter.value !== null
  );
}

function clampLimit(limit) {
  return Math.min(50, Math.max(1, Math.trunc(toNumber(limit, 12))));
}

function formatCreator(creator, plan) {
  const primaryMetric = plan.intent === "custom" ? "custom_score" : plan.sort || INTENT_CONFIG[plan.intent]?.sort;
  return {
    author_name: creator.author_name,
    is_verified: Boolean(creator.is_verified),
    video_count: toNumber(creator.video_count),
    total_views: toNumber(creator.total_views),
    avg_views: toNumber(creator.avg_views),
    max_views: toNumber(creator.max_views),
    total_likes: toNumber(creator.total_likes),
    total_comments: toNumber(creator.total_comments),
    total_shares: toNumber(creator.total_shares),
    engagement_score: toNumber(creator.engagement_score),
    engagement_rate: toNumber(creator.engagement_rate),
    share_rate: toNumber(creator.share_rate),
    originality_rate: toNumber(creator.originality_rate),
    hit_rate: toNumber(creator.hit_rate),
    breakout_video_ratio: toNumber(creator.breakout_video_ratio),
    promising_score: toNumber(creator.promising_score),
    undiscovered_score: toNumber(creator.undiscovered_score),
    custom_score: creator.custom_score === undefined ? null : toNumber(creator.custom_score),
    top_hashtag: creator.top_hashtag,
    top_music: creator.top_music,
    representative_caption: creator.representative_caption,
    genres: String(creator.genres || "").split("|").filter(Boolean),
    why: buildWhy(creator, primaryMetric)
  };
}

function buildWhy(creator, primaryMetric) {
  const metric = primaryMetric && creator[primaryMetric] !== undefined ? primaryMetric : "promising_score";
  const metricLabel = metric.replaceAll("_", " ");
  const value = toNumber(creator[metric]);
  const formatted = value >= 1000 ? Math.round(value).toLocaleString() : value.toFixed(3).replace(/\.?0+$/, "");
  return `Ranks strongly on ${metricLabel} (${formatted}) with ${toNumber(
    creator.video_count
  )} trending video${toNumber(creator.video_count) === 1 ? "" : "s"}.`;
}
