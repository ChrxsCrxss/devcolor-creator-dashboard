import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import initSqlJs from "sql.js";
import {
  captionWordCount,
  clamp,
  countMatches,
  deriveGenres,
  percentileRanks,
  safeDivide,
  toNumber
} from "./features.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const CSV_PATH = path.join(ROOT_DIR, "2026datathon_interview_data.csv");

export async function createDatabase() {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(ROOT_DIR, "node_modules", "sql.js", "dist", file)
  });
  const db = new SQL.Database();
  const rows = loadCsvRows();

  createVideosTable(db);
  insertVideos(db, rows);

  const creators = buildCreatorMetrics(rows);
  createCreatorMetricsTable(db);
  insertCreatorMetrics(db, creators);

  return {
    db,
    stats: {
      videos: rows.length,
      creators: creators.length,
      verifiedCreators: creators.filter((creator) => creator.is_verified).length
    }
  };
}

function loadCsvRows() {
  const csv = fs.readFileSync(CSV_PATH, "utf8");
  return parse(csv, {
    columns: true,
    skip_empty_lines: true,
    bom: true
  }).map((row) => ({
    views: toNumber(row.views),
    likes: toNumber(row.likes),
    comments: toNumber(row.comments),
    shares: toNumber(row.shares),
    author_verified: row.author_verified === "True" ? 1 : 0,
    primary_hashtag: row.primary_hashtag || "",
    music_name: row.music_name || "",
    music_is_original: row.music_is_original === "True" ? 1 : 0,
    duration_sec: toNumber(row.duration_sec),
    caption: row.caption || "",
    upload_date: row.upload_date || "",
    author_name: row.author_name || "unknown",
    video_id: row.video_id || ""
  }));
}

function createVideosTable(db) {
  db.run(`
    CREATE TABLE videos (
      video_id TEXT PRIMARY KEY,
      author_name TEXT NOT NULL,
      views INTEGER NOT NULL,
      likes INTEGER NOT NULL,
      comments INTEGER NOT NULL,
      shares INTEGER NOT NULL,
      author_verified INTEGER NOT NULL,
      primary_hashtag TEXT,
      music_name TEXT,
      music_is_original INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL,
      caption TEXT,
      upload_date TEXT
    );
  `);
}

function insertVideos(db, rows) {
  const statement = db.prepare(`
    INSERT INTO videos (
      video_id, author_name, views, likes, comments, shares, author_verified,
      primary_hashtag, music_name, music_is_original, duration_sec, caption, upload_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.run("BEGIN TRANSACTION");
  for (const row of rows) {
    statement.run([
      row.video_id,
      row.author_name,
      row.views,
      row.likes,
      row.comments,
      row.shares,
      row.author_verified,
      row.primary_hashtag,
      row.music_name,
      row.music_is_original,
      row.duration_sec,
      row.caption,
      row.upload_date
    ]);
  }
  statement.free();
  db.run("COMMIT");
}

function buildCreatorMetrics(rows) {
  const grouped = new Map();
  const viewThreshold = percentileValue(
    rows.map((row) => row.views),
    0.75
  );
  const engagementThreshold = percentileValue(
    rows.map((row) => row.likes + 3 * row.comments + 5 * row.shares),
    0.75
  );

  for (const row of rows) {
    if (!grouped.has(row.author_name)) {
      grouped.set(row.author_name, []);
    }
    grouped.get(row.author_name).push(row);
  }

  const creators = [...grouped.entries()].map(([authorName, videos]) => {
    const totals = videos.reduce(
      (sum, video) => {
        const engagement = video.likes + 3 * video.comments + 5 * video.shares;
        return {
          views: sum.views + video.views,
          likes: sum.likes + video.likes,
          comments: sum.comments + video.comments,
          shares: sum.shares + video.shares,
          engagement: sum.engagement + engagement,
          originalMusic: sum.originalMusic + video.music_is_original,
          duration: sum.duration + video.duration_sec,
          captionWords: sum.captionWords + captionWordCount(video.caption),
          captionHashtags: sum.captionHashtags + countMatches(video.caption, /#[^\s#]+/g),
          captionMentions: sum.captionMentions + countMatches(video.caption, /@[\w.]+/g),
          hitVideos:
            sum.hitVideos + (video.views >= viewThreshold || engagement >= engagementThreshold ? 1 : 0)
        };
      },
      {
        views: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        engagement: 0,
        originalMusic: 0,
        duration: 0,
        captionWords: 0,
        captionHashtags: 0,
        captionMentions: 0,
        hitVideos: 0
      }
    );

    const uploadTimes = videos
      .map((video) => Date.parse(video.upload_date))
      .filter((time) => Number.isFinite(time));
    const postingSpanDays = uploadTimes.length
      ? Math.max(0, (Math.max(...uploadTimes) - Math.min(...uploadTimes)) / 86400000)
      : 0;
    const hashtags = videos.map((video) => video.primary_hashtag).filter(Boolean);
    const hashtagCounts = countBy(hashtags);
    const musicCounts = countBy(videos.map((video) => video.music_name).filter(Boolean));
    const maxViews = Math.max(...videos.map((video) => video.views));
    const avgViews = safeDivide(totals.views, videos.length);
    const postingConsistency = videos.length > 1 ? safeDivide(videos.length - 1, postingSpanDays + 1) : 0;

    return {
      author_name: authorName,
      is_verified: Math.max(...videos.map((video) => video.author_verified)),
      video_count: videos.length,
      total_views: totals.views,
      avg_views: avgViews,
      max_views: maxViews,
      total_likes: totals.likes,
      total_comments: totals.comments,
      total_shares: totals.shares,
      engagement_score: totals.engagement,
      engagement_rate: safeDivide(totals.engagement, totals.views),
      share_rate: safeDivide(totals.shares, totals.views),
      originality_rate: safeDivide(totals.originalMusic, videos.length),
      avg_duration_sec: safeDivide(totals.duration, videos.length),
      posting_span_days: postingSpanDays,
      posting_consistency: postingConsistency,
      hashtag_diversity: safeDivide(new Set(hashtags).size, videos.length),
      caption_word_avg: safeDivide(totals.captionWords, videos.length),
      caption_hashtags_avg: safeDivide(totals.captionHashtags, videos.length),
      caption_mentions_avg: safeDivide(totals.captionMentions, videos.length),
      hit_rate: safeDivide(totals.hitVideos, videos.length),
      breakout_video_ratio: safeDivide(maxViews, avgViews),
      top_hashtag: topEntry(hashtagCounts),
      top_music: topEntry(musicCounts),
      representative_caption: videos.sort((a, b) => b.views - a.views)[0]?.caption || "",
      // Pipe-delimited (|dance|music|) so SQL LIKE '%|dance|%' matches cleanly.
      genres: (() => {
        const list = deriveGenres(videos);
        return list.length ? `|${list.join("|")}|` : "";
      })()
    };
  });

  const reachPercentiles = percentileRanks(creators, "total_views");
  const engagementPercentiles = percentileRanks(creators, "engagement_rate");
  const consistencyPercentiles = percentileRanks(creators, "posting_consistency");

  return creators.map((creator) => {
    const engagementQuality = clamp(engagementPercentiles.get(creator.author_name));
    const reachPercentile = clamp(reachPercentiles.get(creator.author_name));
    const consistencyScore = clamp(consistencyPercentiles.get(creator.author_name));
    const undiscoveredScore =
      creator.is_verified === 0
        ? 0.45 * engagementQuality + 0.35 * reachPercentile + 0.2 * creator.hit_rate
        : 0;
    const promisingScore =
      0.35 * engagementQuality +
      0.25 * reachPercentile +
      0.2 * creator.hit_rate +
      0.1 * creator.originality_rate +
      0.1 * consistencyScore;

    return {
      ...creator,
      engagement_quality: engagementQuality,
      reach_percentile: reachPercentile,
      engagement_percentile: engagementQuality,
      consistency_score: consistencyScore,
      undiscovered_score: undiscoveredScore,
      promising_score: promisingScore
    };
  });
}

function createCreatorMetricsTable(db) {
  db.run(`
    CREATE TABLE creator_metrics (
      author_name TEXT PRIMARY KEY,
      is_verified INTEGER NOT NULL,
      video_count INTEGER NOT NULL,
      total_views REAL NOT NULL,
      avg_views REAL NOT NULL,
      max_views REAL NOT NULL,
      total_likes REAL NOT NULL,
      total_comments REAL NOT NULL,
      total_shares REAL NOT NULL,
      engagement_score REAL NOT NULL,
      engagement_rate REAL NOT NULL,
      share_rate REAL NOT NULL,
      originality_rate REAL NOT NULL,
      avg_duration_sec REAL NOT NULL,
      posting_span_days REAL NOT NULL,
      posting_consistency REAL NOT NULL,
      hashtag_diversity REAL NOT NULL,
      caption_word_avg REAL NOT NULL,
      caption_hashtags_avg REAL NOT NULL,
      caption_mentions_avg REAL NOT NULL,
      hit_rate REAL NOT NULL,
      breakout_video_ratio REAL NOT NULL,
      engagement_quality REAL NOT NULL,
      reach_percentile REAL NOT NULL,
      engagement_percentile REAL NOT NULL,
      consistency_score REAL NOT NULL,
      undiscovered_score REAL NOT NULL,
      promising_score REAL NOT NULL,
      top_hashtag TEXT,
      top_music TEXT,
      representative_caption TEXT,
      genres TEXT
    );
  `);
}

function insertCreatorMetrics(db, creators) {
  const columns = [
    "author_name",
    "is_verified",
    "video_count",
    "total_views",
    "avg_views",
    "max_views",
    "total_likes",
    "total_comments",
    "total_shares",
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
    "promising_score",
    "top_hashtag",
    "top_music",
    "representative_caption",
    "genres"
  ];
  const statement = db.prepare(`
    INSERT INTO creator_metrics (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `);

  db.run("BEGIN TRANSACTION");
  for (const creator of creators) {
    statement.run(columns.map((column) => creator[column]));
  }
  statement.free();
  db.run("COMMIT");
}

function percentileValue(values, percentile) {
  const sorted = values.map((value) => toNumber(value)).sort((a, b) => a - b);
  if (!sorted.length) {
    return 0;
  }
  return sorted[Math.floor((sorted.length - 1) * percentile)];
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map());
}

function topEntry(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}
