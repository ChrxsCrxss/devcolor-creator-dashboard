import { useEffect, useState } from "react";

const METRIC_OPTIONS = [
  "engagement_quality",
  "reach_percentile",
  "hit_rate",
  "originality_rate",
  "consistency_score",
  "total_views",
  "video_count",
  "share_rate",
  "breakout_video_ratio",
  "undiscovered_score"
];

const FILTER_FIELDS = [
  ["is_verified", "Verification"],
  ["video_count", "Videos"],
  ["total_views", "Total views"],
  ["total_shares", "Total shares"],
  ["share_rate", "Share rate"],
  ["engagement_rate", "Engagement rate"]
];

const FILTER_LABELS = Object.fromEntries(FILTER_FIELDS);

const FILTER_DEFAULTS = {
  is_verified: { operator: "=", value: 0 },
  video_count: { operator: ">=", value: 2 },
  total_views: { operator: ">=", value: 100000 },
  total_shares: { operator: ">=", value: 1000 },
  share_rate: { operator: ">=", value: 0.01 },
  engagement_rate: { operator: ">=", value: 0.05 }
};

const FILTER_OPERATORS = [">=", ">", "<=", "<", "="];

// Starter draft so the builder is usable the moment you land, before any chat.
const emptyDraft = () => ({
  label: "Custom ranking",
  description: "Pick signals, filters, and genres — or ask the assistant to shape it for you.",
  components: [],
  filters: [],
  genres: []
});

const hasDraftContent = (draft) =>
  Boolean(
    draft &&
      ((draft.components && draft.components.length) ||
        (draft.genres && draft.genres.length) ||
        (draft.filters && draft.filters.length))
  );

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
// Budget is based on weight magnitude: a signal can be positive (higher ranks
// up) or negative (lower ranks up), but the total "size" of the blend is the
// sum of absolute values, which is how the server normalizes it.
const sumWeights = (components) =>
  components.reduce((total, c) => total + Math.abs(Number(c.weight || 0)), 0);
const signOf = (weight) => (Number(weight) < 0 ? -1 : 1);

// Keep a proposed draft's weight magnitudes within a total of 1 (scale down if
// the model over-allocates) while preserving each signal's direction, so the
// panel always starts in a valid state.
function fitDraft(draft) {
  if (!draft?.components?.length) return draft;
  const total = sumWeights(draft.components);
  if (total <= 1) return draft;
  return {
    ...draft,
    components: draft.components.map((c) => ({ ...c, weight: round2(c.weight / total) }))
  };
}

const FEATURE_DEFINITIONS = {
  engagement_quality: {
    description: "Weighted engagement normalized by views, useful for quality over raw size.",
    source: "views, likes, comments, shares",
    formula: "percentile((likes + 3 * comments + 5 * shares) / views)",
    scale: "Percentile, 0-100 in manual mix",
    bestFor: "Finding creators whose audience reacts strongly relative to reach.",
    caveat: "Does not include saves, watch time, follower count, or audience quality."
  },
  reach_percentile: {
    description: "Creator's total views compared with other creators in this CSV.",
    source: "views, author_name",
    formula: "percentile(sum(views) grouped by creator)",
    scale: "Percentile, 0-100",
    bestFor: "Ranking creators by observed reach in the trending export.",
    caveat: "Reach means views in this dataset, not followers or unique viewers."
  },
  hit_rate: {
    description: "Share of a creator's videos that beat dataset top-quartile thresholds.",
    source: "views, likes, comments, shares, video_id",
    formula: "videos above p75 views or p75 weighted engagement / video_count",
    scale: "Ratio, then percentile in manual mix",
    bestFor: "Finding repeat performers instead of one-off spikes.",
    caveat: "Creators with one video can look strong from a single hit."
  },
  originality_rate: {
    description: "Share of videos using original music.",
    source: "music_is_original, author_name",
    formula: "count(music_is_original = true) / video_count",
    scale: "Ratio, then percentile in manual mix",
    bestFor: "Finding creators who may create reusable sounds or original formats.",
    caveat: "Original music is a proxy for originality, not a full content originality measure."
  },
  consistency_score: {
    description: "Relative posting consistency across the observed upload dates.",
    source: "upload_date, author_name, video_count",
    formula: "percentile((video_count - 1) / (posting_span_days + 1))",
    scale: "Percentile, 0-100 in manual mix",
    bestFor: "Finding creators who show repeated presence over the export window.",
    caveat: "The CSV is trending-video data, not a creator's complete posting history."
  },
  total_views: {
    description: "Total views across all trending videos for that creator.",
    source: "views, author_name",
    formula: "sum(views) grouped by creator",
    scale: "Raw count, converted to percentile in manual mix",
    bestFor: "Simple reach-oriented rankings.",
    caveat: "Large single-video spikes can dominate the total."
  },
  video_count: {
    description: "Number of trending videos from the creator in this batch.",
    source: "video_id, author_name",
    formula: "count(video_id) grouped by creator",
    scale: "Raw count, converted to percentile in manual mix",
    bestFor: "Finding prolific creators with repeated trending appearances.",
    caveat: "A low count may reflect the export window rather than the creator's real output."
  },
  share_rate: {
    description: "Shares divided by views, a lightweight virality signal.",
    source: "shares, views",
    formula: "sum(shares) / sum(views)",
    scale: "Ratio, converted to percentile in manual mix",
    bestFor: "Finding content that people actively pass along.",
    caveat: "Very small-view videos can produce noisy rates."
  },
  breakout_video_ratio: {
    description: "Top video views compared with the creator's own average.",
    source: "views, author_name",
    formula: "max(views) / avg(views)",
    scale: "Ratio, converted to percentile in manual mix",
    bestFor: "Finding creators with a standout breakout post.",
    caveat: "One-video creators have limited breakout context."
  },
  undiscovered_score: {
    description: "Unverified creator score combining engagement quality, reach, and hit rate.",
    source: "author_verified, engagement_quality, reach_percentile, hit_rate",
    formula: "if unverified: 0.45 * engagement_quality + 0.35 * reach_percentile + 0.20 * hit_rate",
    scale: "Composite score, converted to percentile in manual mix",
    bestFor: "Finding high-potential creators without verified status.",
    caveat: "Verified status is the only creator-status signal in the CSV."
  }
};

export default function App() {
  const [summary, setSummary] = useState(null);
  const [health, setHealth] = useState(null);
  const [question, setQuestion] = useState("");
  const [conversation, setConversation] = useState([]);
  const [activeResult, setActiveResult] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [readyToRun, setReadyToRun] = useState(false);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const [activePage, setActivePage] = useState("ask");
  const [selectedCreator, setSelectedCreator] = useState(null);
  const [creatorVideos, setCreatorVideos] = useState([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [savedRankings, setSavedRankings] = useState([]);
  const [saving, setSaving] = useState(false);
  const [genreFacets, setGenreFacets] = useState([]);

  useEffect(() => {
    Promise.all([fetchJson("/api/summary"), fetchJson("/api/health"), fetchJson("/api/rankings")])
      .then(([summaryResponse, healthResponse, rankingsResponse]) => {
        setSummary(summaryResponse);
        setGenreFacets(summaryResponse.genres || []);
        setSavedRankings(rankingsResponse.rankings || []);
        setActiveResult({
          answer:
            "Start with the summary below, or ask a plain-English question to generate a custom ranking.",
          creators: summaryResponse.sections[0]?.creators || [],
          plan: {
            interpretedAs: "Default promising creator score."
          },
          caveats: summaryResponse.caveats
        });
        setHealth(healthResponse);
      })
      .catch((error) => {
        setConversation((items) => [...items, { role: "system", text: error.message }]);
      });
  }, []);

  async function sendMessage(event, overrideText = null) {
    event?.preventDefault();
    const text = (overrideText || question).trim();
    if (!text || loading) return;

    const history = conversation
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, text: message.text }));

    setLoading(true);
    setQuestion("");
    setConversation((items) => [...items, { role: "user", text }]);

    try {
      const result = await fetchJson("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "discuss", question: text, history, draft })
      });

      if (result.draft)
        setDraft((current) => ({
          ...fitDraft(result.draft),
          genres: result.draft.genres || current?.genres || []
        }));
      setReadyToRun(Boolean(result.readyToRun));
      setConversation((items) => [
        ...items,
        {
          role: "assistant",
          text: result.message,
          clarifyingQuestions: result.clarifyingQuestions || [],
          suggestedSignals: result.suggestedSignals || []
        }
      ]);
    } catch (error) {
      setConversation((items) => [...items, { role: "system", text: error.message }]);
    } finally {
      setLoading(false);
    }
  }

  async function runDraft(recipe = draft) {
    if (!hasDraftContent(recipe) || running) return;

    setRunning(true);
    try {
      const result = await fetchJson("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run", draft: recipe })
      });
      setActiveResult(result);
      setActivePage("ask");
      setConversation((items) => [
        ...items,
        {
          role: "assistant",
          status: "success",
          text: `Ran "${result.plan?.label || "ranking"}" — ${result.creators?.length || 0} creators ranked.`
        }
      ]);
    } catch (error) {
      setConversation((items) => [...items, { role: "system", text: error.message }]);
    } finally {
      setRunning(false);
    }
  }

  async function saveDraft(recipe = draft) {
    if (!hasDraftContent(recipe) || saving) return;

    setSaving(true);
    try {
      const result = await fetchJson("/api/rankings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: recipe })
      });
      setSavedRankings((items) => [result.ranking, ...items.filter((item) => item.id !== result.ranking.id)]);
      setConversation((items) => [
        ...items,
        {
          role: "assistant",
          status: "success",
          text: `Saved "${result.ranking.title}" to At-a-glance.`
        }
      ]);
    } catch (error) {
      setConversation((items) => [...items, { role: "system", text: error.message }]);
    } finally {
      setSaving(false);
    }
  }

  async function deleteRanking(id) {
    const previous = savedRankings;
    setSavedRankings((items) => items.filter((item) => item.id !== id));
    try {
      await fetchJson(`/api/rankings/${id}`, { method: "DELETE" });
    } catch (error) {
      setSavedRankings(previous);
      setConversation((items) => [...items, { role: "system", text: error.message }]);
    }
  }

  // `weight` here is a magnitude (0..1) from the slider; direction is preserved.
  function updateDraftWeight(field, weight) {
    setDraft((current) => {
      if (!current) return current;
      const others = current.components
        .filter((component) => component.field !== field)
        .reduce((total, component) => total + Math.abs(Number(component.weight || 0)), 0);
      const maxAllowed = round2(1 - others);
      const magnitude = Math.max(0, Math.min(Math.abs(Number(weight)), maxAllowed));
      return {
        ...current,
        components: current.components.map((component) =>
          component.field === field
            ? { ...component, weight: round2(magnitude * signOf(component.weight)) }
            : component
        )
      };
    });
  }

  // Flip a signal between "higher is better" (+) and "lower is better" (-)
  // without changing its magnitude or the total budget.
  function updateDraftDirection(field, sign) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        components: current.components.map((component) =>
          component.field === field
            ? { ...component, weight: round2(Math.abs(Number(component.weight || 0)) * sign) }
            : component
        )
      };
    });
    setReadyToRun(false);
  }

  function removeSignal(field) {
    setDraft((current) =>
      current
        ? { ...current, components: current.components.filter((component) => component.field !== field) }
        : current
    );
    setReadyToRun(false);
  }

  function addSignal(field) {
    setDraft((current) => {
      const base = current || {
        label: "Custom ranking",
        description: "Weighted blend of signals.",
        components: [],
        filters: []
      };
      if (base.components.some((component) => component.field === field)) return base;

      const remaining = round2(1 - sumWeights(base.components));
      if (remaining >= 0.1) {
        return {
          ...base,
          components: [...base.components, { field, weight: Math.min(0.25, remaining) }]
        };
      }
      // No budget left: make room by scaling existing signals to 80%.
      const scaled = base.components.map((component) => ({
        ...component,
        weight: round2(component.weight * 0.8)
      }));
      return { ...base, components: [...scaled, { field, weight: 0.2 }] };
    });
    setReadyToRun(false);
  }

  function addFilter(field) {
    setDraft((current) => {
      const base = current || {
        label: "Custom ranking",
        description: "Weighted blend of signals.",
        components: [],
        filters: []
      };
      const filters = base.filters || [];
      if (filters.some((filter) => filter.field === field)) return base;
      return { ...base, filters: [...filters, { field, ...FILTER_DEFAULTS[field] }] };
    });
  }

  function updateFilter(field, patch) {
    setDraft((current) =>
      current
        ? {
            ...current,
            filters: (current.filters || []).map((filter) =>
              filter.field === field ? { ...filter, ...patch } : filter
            )
          }
        : current
    );
  }

  function removeFilter(field) {
    setDraft((current) =>
      current
        ? { ...current, filters: (current.filters || []).filter((filter) => filter.field !== field) }
        : current
    );
  }

  function addGenre(genre) {
    setDraft((current) => {
      const base = current || {
        label: "Custom ranking",
        description: "Weighted blend of signals.",
        components: [],
        filters: []
      };
      const genres = base.genres || [];
      if (genres.includes(genre)) return base;
      return { ...base, genres: [...genres, genre] };
    });
    setReadyToRun(false);
  }

  function removeGenre(genre) {
    setDraft((current) =>
      current ? { ...current, genres: (current.genres || []).filter((item) => item !== genre) } : current
    );
  }

  async function openCreator(creator) {
    setSelectedCreator(creator);
    setCreatorVideos([]);
    setModalLoading(true);

    try {
      const result = await fetchJson(`/api/creators/${encodeURIComponent(creator.author_name)}/videos`);
      setCreatorVideos(result.videos || []);
    } catch (error) {
      setCreatorVideos([]);
      setConversation((items) => [...items, { role: "system", text: error.message }]);
    } finally {
      setModalLoading(false);
    }
  }

  function closeCreator() {
    setSelectedCreator(null);
    setCreatorVideos([]);
    setModalLoading(false);
  }

  function startChatResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = chatWidth;

    function handleMove(moveEvent) {
      const nextWidth = startWidth + (startX - moveEvent.clientX);
      setChatWidth(Math.min(720, Math.max(340, nextWidth)));
    }

    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div className="appFrame">
      <header className="topNav">
        <div className="brandLockup">
          <span className="brandMark" aria-hidden="true">TD</span>
          <span className="brandText">
            <span className="brandName">Trend Data Explorer</span>
            <span className="brandKicker">DevColor partnerships</span>
          </span>
        </div>
        <nav>
          {[
            ["ask", "Ask"],
            ["glance", "At-a-glance"],
            ["features", "Features"]
          ].map(([page, title]) => (
            <button
              className={activePage === page ? "active" : ""}
              key={page}
              onClick={() => setActivePage(page)}
            >
              {title}
            </button>
          ))}
        </nav>
        <div className="navRight">
          <HealthPill health={health} />
        </div>
      </header>

      {activePage === "ask" && (
        <main className="askPage" style={{ gridTemplateColumns: `minmax(0, 1fr) ${chatWidth}px` }}>
          <section className="answerStage">
            <div className="stageHeader">
              <div>
                <p className="eyebrow">Discovery</p>
                <h2>{running ? "Ranking creators..." : draft ? "Shape the ranking, then run it" : "Ranked creator results"}</h2>
              </div>
              {activeResult?.plan?.interpretedAs && !running && (
                <p className="interpreted">{activeResult.plan.interpretedAs}</p>
              )}
            </div>

            {draft && (
              <DraftPanel
                draft={draft}
                readyToRun={readyToRun}
                running={running}
                saving={saving}
                onRun={() => runDraft()}
                onSave={() => saveDraft()}
                onWeight={updateDraftWeight}
                onDirection={updateDraftDirection}
                onRemove={removeSignal}
                onAdd={addSignal}
                onAddFilter={addFilter}
                onUpdateFilter={updateFilter}
                onRemoveFilter={removeFilter}
                genreFacets={genreFacets}
                onAddGenre={addGenre}
                onRemoveGenre={removeGenre}
              />
            )}

            {running ? (
              <LoadingAnswer />
            ) : activeResult ? (
              <>
                <ResultSummary creators={activeResult.creators || []} onSelect={openCreator} />
                <CreatorGrid creators={activeResult.creators || []} onSelect={openCreator} />
              </>
            ) : (
              <p>Loading creator rankings...</p>
            )}
          </section>

          <aside className="chatRail">
            <div className="railHandle" onPointerDown={startChatResize} title="Drag to resize chat" />
            <div className="brandBlock">
              <p className="eyebrow">Talk to your data</p>
              <h1>Discover, then rank.</h1>
              <p>
                I work like an analytics engineer: we agree on a definition first, then I run it.
                Nothing executes until you hit Run.
              </p>
            </div>

            <div className="conversation">
              {!conversation.length && (
                <article className="message assistant">
                  <p>
                    Start with a fuzzy idea, like "creators with hardcore fanbases" or "undiscovered
                    but growing." I'll tell you what this data can and can't measure, propose a
                    ranking on the left, and ask questions to sharpen it.
                  </p>
                </article>
              )}
              {conversation.map((message, index) =>
                message.status === "success" ? (
                  <div className="statusLine" key={`status-${index}`}>
                    <span className="statusCheck" aria-hidden="true">✓</span>
                    <span>{message.text}</span>
                  </div>
                ) : (
                <article className={`message ${message.role}`} key={`${message.role}-${index}`}>
                  {message.role === "assistant" ? (
                    <MarkdownLite text={message.text} />
                  ) : (
                    <p>{message.text}</p>
                  )}
                  {message.clarifyingQuestions?.length > 0 && (
                    <div className="msgSection">
                      <p className="msgSectionHead">Questions to consider</p>
                      <ul className="considerList">
                        {message.clarifyingQuestions.map((item) => (
                          <li key={item}>
                            <button className="considerItem" onClick={() => sendMessage(null, item)}>
                              <span className="considerQ" aria-hidden="true">?</span>
                              <span>{item}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {message.suggestedSignals?.length > 0 && (
                    <div className="msgSection">
                      <p className="msgSectionHead">Signals to add</p>
                      <div className="signalSuggest">
                        {message.suggestedSignals.map((signal) => (
                          <button
                            className="chip"
                            key={signal.field}
                            title={signal.description}
                            onClick={() => addSignal(signal.field)}
                          >
                            + {label(signal.field)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
                )
              )}
              {loading && (
                <article className="message assistant">
                  <p className="typing">Thinking through the options...</p>
                </article>
              )}
            </div>

            <form className="askForm" onSubmit={sendMessage}>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendMessage(event);
                  }
                }}
                placeholder="Describe the kind of creators you're looking for..."
                rows={3}
              />
              <button disabled={loading}>{loading ? "Thinking..." : "Send"}</button>
            </form>
          </aside>
        </main>
      )}

      {activePage === "glance" && (
        <main className="staticPage">
          <section className="pageHero">
            <p className="eyebrow">At-a-glance</p>
            <h1>Ranked lists by metric</h1>
            <p>Static scans of the top 25 creators for each partnership signal.</p>
          </section>

          <section className="glanceSection">
            <div className="glanceSectionHead">
              <div>
                <p className="eyebrow">Saved rankings</p>
                <h2>Your rankings</h2>
              </div>
              <button className="ghostButton" onClick={() => setActivePage("ask")}>
                + Build a new ranking
              </button>
            </div>
            {savedRankings.length ? (
              <div className="summaryGrid full">
                {savedRankings.map((section) => (
                  <SummaryRankedList
                    key={section.id}
                    section={section}
                    onRemove={() => deleteRanking(section.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="glanceEmpty">
                Nothing saved yet. Shape a ranking in <b>Ask</b> and hit <b>Save to At-a-glance</b> to
                pin it here.
              </p>
            )}
          </section>

          <section className="glanceSection">
            <div className="glanceSectionHead">
              <div>
                <p className="eyebrow">Built-in</p>
                <h2>Standard signals</h2>
              </div>
            </div>
            <div className="summaryGrid full">
              {summary?.sections?.map((section) => (
                <SummaryRankedList key={section.key} section={section} />
              ))}
            </div>
          </section>
        </main>
      )}

      {activePage === "features" && (
        <main className="staticPage">
          <section className="pageHero">
            <p className="eyebrow">Features</p>
            <h1>Signals and feature recipes</h1>
            <p>These are the concrete metrics the chat uses to translate vague creator strategy ideas.</p>
          </section>
          <section className="featureRows">
            {METRIC_OPTIONS.map((metric) => (
              <article className="featureRow" key={metric}>
                <div className="featureName">
                  <strong>{label(metric)}</strong>
                  <span>{FEATURE_DEFINITIONS[metric].scale}</span>
                </div>
                <p>{FEATURE_DEFINITIONS[metric].description}</p>
                <div>
                  <small>Source</small>
                  <span>{FEATURE_DEFINITIONS[metric].source}</span>
                </div>
                <div>
                  <small>Calculation</small>
                  <span>{FEATURE_DEFINITIONS[metric].formula}</span>
                </div>
                <div>
                  <small>Use / caveat</small>
                  <span>
                    {FEATURE_DEFINITIONS[metric].bestFor} {FEATURE_DEFINITIONS[metric].caveat}
                  </span>
                </div>
              </article>
            ))}
          </section>
          <Caveats caveats={activeResult?.caveats || summary?.caveats || []} />
        </main>
      )}

      {selectedCreator && (
        <CreatorModal
          creator={selectedCreator}
          videos={creatorVideos}
          loading={modalLoading}
          onClose={closeCreator}
        />
      )}
    </div>
  );
}

// Tiny, safe markdown renderer: **bold**, *italic*, `code`, and - bullet lists.
// Avoids a dependency and dangerouslySetInnerHTML.
function renderInline(text, keyPrefix) {
  const parts = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let match;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={`${keyPrefix}-${i}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(<code key={`${keyPrefix}-${i}`}>{token.slice(1, -1)}</code>);
    } else {
      parts.push(<em key={`${keyPrefix}-${i}`}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
    i += 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MarkdownLite({ text }) {
  const lines = String(text || "").split(/\n/);
  const blocks = [];
  let list = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      if (!list) list = [];
      list.push(line.replace(/^[-*•]\s+/, ""));
      continue;
    }
    if (list) {
      blocks.push({ type: "ul", items: list });
      list = null;
    }
    if (line) blocks.push({ type: "p", text: line });
  }
  if (list) blocks.push({ type: "ul", items: list });

  return (
    <div className="markdown">
      {blocks.map((block, i) =>
        block.type === "ul" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{renderInline(block.text, `p-${i}`)}</p>
        )
      )}
    </div>
  );
}

function ResultSummary({ creators, onSelect }) {
  if (!creators.length) {
    return <p className="resultEmpty">No creators matched those criteria in this dataset.</p>;
  }

  const leaders = creators.slice(0, 3);
  return (
    <div className="resultSummary">
      <span className="resultCount">{creators.length} creators ranked</span>
      <span className="resultLeadersLabel">Leaders</span>
      <span className="resultLeaders">
        {leaders.map((creator, index) => (
          <button
            className="leaderName"
            key={creator.author_name}
            onClick={() => onSelect?.(creator)}
          >
            <span className="leaderRank">#{index + 1}</span>
            {creator.author_name}
          </button>
        ))}
      </span>
    </div>
  );
}

function CreatorGrid({ creators, onSelect }) {
  return (
    <div className="creatorGrid">
      {creators.map((creator, index) => (
        <article
          className="creatorCard"
          key={creator.author_name}
          onClick={() => onSelect?.(creator)}
          role={onSelect ? "button" : undefined}
          tabIndex={onSelect ? 0 : undefined}
          onKeyDown={(event) => {
            if (onSelect && (event.key === "Enter" || event.key === " ")) {
              onSelect(creator);
            }
          }}
        >
          <span className="rankBadge">#{index + 1}</span>
          <div className="creatorTop">
            <h3>{creator.author_name}</h3>
            <span>{creator.is_verified ? "Verified" : "Unverified"}</span>
          </div>
          <p>{creator.why}</p>
          <dl>
            <Metric label="Views" value={compact(creator.total_views)} />
            <Metric label="Videos" value={creator.video_count} />
            <Metric label="Engagement" value={compact(creator.engagement_score)} />
            <Metric label="Shares" value={compact(creator.total_shares)} />
            <Metric label="Originality" value={percent(creator.originality_rate)} />
            <Metric label="Hit rate" value={percent(creator.hit_rate)} />
          </dl>
          {creator.genres?.length > 0 && (
            <div className="cardGenres">
              {creator.genres.slice(0, 3).map((genre) => (
                <span className="cardGenre" key={genre}>
                  {genre}
                </span>
              ))}
            </div>
          )}
          <div className="meta">
            {creator.top_hashtag && <span>#{creator.top_hashtag}</span>}
            {creator.top_music && <span>{creator.top_music}</span>}
          </div>
        </article>
      ))}
    </div>
  );
}

function SummaryRankedList({ section, onRemove }) {
  return (
    <article className={section.saved ? "summaryCard rankedList saved" : "summaryCard rankedList"}>
      <div className="summaryCardHead">
        <div>
          {section.saved && <span className="savedTag">Saved</span>}
          <h3>{section.title}</h3>
        </div>
        {onRemove && (
          <button className="removeSignal" onClick={onRemove} title="Remove this saved ranking">
            Remove
          </button>
        )}
      </div>
      <p>{section.definition}</p>
      <ol>
        {section.creators.map((creator, index) => (
          <li key={creator.author_name}>
            <b className="summaryRank">#{index + 1}</b>
            <div>
              <strong>{creator.author_name}</strong>
              <span>{creator.why}</span>
            </div>
            <em>
              {section.saved
                ? percent(creator.custom_score)
                : summaryMetric(section.key, creator)}
            </em>
          </li>
        ))}
      </ol>
    </article>
  );
}

function DraftPanel({
  draft,
  readyToRun,
  running,
  saving,
  onRun,
  onSave,
  onWeight,
  onDirection,
  onRemove,
  onAdd,
  onAddFilter,
  onUpdateFilter,
  onRemoveFilter,
  genreFacets = [],
  onAddGenre,
  onRemoveGenre
}) {
  const usedFields = new Set(draft.components.map((component) => component.field));
  const remaining = METRIC_OPTIONS.filter((field) => !usedFields.has(field));
  const filters = draft.filters || [];
  const usedFilterFields = new Set(filters.map((filter) => filter.field));
  const availableFilters = FILTER_FIELDS.filter(([field]) => !usedFilterFields.has(field));
  const weightTotal = Math.round(sumWeights(draft.components) * 100);
  const selectedGenres = draft.genres || [];
  const runnable = hasDraftContent(draft);

  return (
    <section className={readyToRun ? "draftPanel ready" : "draftPanel"}>
      <div className="draftHeader">
        <div>
          <p className="eyebrow">
            Build a ranking {readyToRun && <span className="readyTag">looks ready</span>}
          </p>
          <h2>{draft.label}</h2>
          <p>{draft.description}</p>
        </div>
        <div className="draftActions">
          <button
            className="saveButton"
            disabled={saving || !runnable}
            onClick={onSave}
            title="Save this ranking to the At-a-glance page"
          >
            {saving ? "Saving..." : "Save to At-a-glance"}
          </button>
          <button className="runButton" disabled={running || !runnable} onClick={onRun}>
            {running ? "Running..." : "Run this ranking"}
          </button>
        </div>
      </div>

      {draft.components.length ? (
        <>
        <div className="draftSectionHead">
          <p className="draftRationaleHead">How I'm measuring this</p>
          <span className={weightTotal >= 100 ? "weightTotal full" : "weightTotal"}>
            {weightTotal}% allocated
          </span>
        </div>
        <div className="draftSignals">
          {draft.components.map((component) => {
            const inverted = Number(component.weight) < 0;
            const magnitude = Math.abs(Number(component.weight));
            return (
              <div className={inverted ? "draftSignal inverted" : "draftSignal"} key={component.field}>
                <div className="draftSignalTop">
                  <strong>{label(component.field)}</strong>
                  <button className="removeSignal" onClick={() => onRemove(component.field)}>
                    Remove
                  </button>
                </div>
                <span className="draftSignalDesc">
                  {FEATURE_DEFINITIONS[component.field]?.description}
                  {inverted && " Penalized: creators with low values rank higher."}
                </span>
                <div className="weightControl">
                  <div className="weightControlTop">
                    <div className="dirToggle" role="group" aria-label="Sort direction">
                      <button
                        className={inverted ? "" : "active"}
                        onClick={() => onDirection(component.field, 1)}
                        title="Reward higher values"
                      >
                        Higher
                      </button>
                      <button
                        className={inverted ? "active" : ""}
                        onClick={() => onDirection(component.field, -1)}
                        title="Reward lower values"
                      >
                        Lower
                      </button>
                    </div>
                    <span className={inverted ? "weightValue down" : "weightValue"}>
                      {(inverted ? "−" : "+") + magnitude.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={magnitude}
                    onChange={(event) => onWeight(component.field, event.target.value)}
                  />
                </div>
              </div>
            );
          })}
        </div>
        </>
      ) : (
        <p className="draftEmpty">No signals yet. Add one below or ask me for a suggestion.</p>
      )}

      {remaining.length > 0 && (
        <div className="addSignal">
          <span>Add signal</span>
          <div className="chips">
            {remaining.map((field) => (
              <button
                className="chip"
                key={field}
                title={FEATURE_DEFINITIONS[field]?.description}
                onClick={() => onAdd(field)}
              >
                + {label(field)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="draftFilters">
        <div className="draftSectionHead">
          <p className="draftRationaleHead">Filters</p>
          {availableFilters.length > 0 && (
            <select
              className="addFilterSelect"
              value=""
              onChange={(event) => event.target.value && onAddFilter(event.target.value)}
            >
              <option value="">+ Add filter</option>
              {availableFilters.map(([field, labelText]) => (
                <option key={field} value={field}>
                  {labelText}
                </option>
              ))}
            </select>
          )}
        </div>

        {filters.length ? (
          <div className="filterList">
            {filters.map((filter) => (
              <FilterRow
                key={filter.field}
                filter={filter}
                onUpdate={onUpdateFilter}
                onRemove={onRemoveFilter}
              />
            ))}
          </div>
        ) : (
          <p className="filtersEmpty">No filters — the ranking runs across every creator.</p>
        )}
      </div>

      <GenrePicker
        facets={genreFacets}
        selected={selectedGenres}
        onAdd={onAddGenre}
        onRemove={onRemoveGenre}
      />
    </section>
  );
}

function GenrePicker({ facets, selected, onAdd, onRemove }) {
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selected);
  const q = query.trim().toLowerCase();
  const matches = facets
    .filter((facet) => !selectedSet.has(facet.genre))
    .filter((facet) => !q || facet.genre.includes(q))
    .slice(0, 8);

  return (
    <div className="draftGenres">
      <div className="draftSectionHead">
        <p className="draftRationaleHead">Genres</p>
        {selected.length > 0 && <span className="genreCount">{selected.length} selected</span>}
      </div>

      {selected.length > 0 && (
        <div className="genreChips">
          {selected.map((genre) => (
            <button className="genreChip active" key={genre} onClick={() => onRemove(genre)}>
              {genre}
              <span className="genreChipX" aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      <input
        className="genreSearch"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search genres (e.g. dance, gaming, food)..."
      />

      {matches.length ? (
        <div className="genreChips">
          {matches.map((facet) => (
            <button className="genreChip" key={facet.genre} onClick={() => onAdd(facet.genre)}>
              + {facet.genre}
              <span className="genreFacetCount">{facet.count}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="filtersEmpty">
          {q ? "No matching genres." : "Content filtered to the selected genres (any match)."}
        </p>
      )}
    </div>
  );
}

function FilterRow({ filter, onUpdate, onRemove }) {
  const labelText = FILTER_LABELS[filter.field] || label(filter.field);

  return (
    <div className="filterRow">
      <strong>{labelText}</strong>
      {filter.field === "is_verified" ? (
        <div className="segmented">
          <button
            className={Number(filter.value) === 1 ? "active" : ""}
            onClick={() => onUpdate(filter.field, { operator: "=", value: 1 })}
          >
            Verified only
          </button>
          <button
            className={Number(filter.value) === 0 ? "active" : ""}
            onClick={() => onUpdate(filter.field, { operator: "=", value: 0 })}
          >
            Unverified only
          </button>
        </div>
      ) : (
        <div className="filterControls">
          <select
            value={filter.operator}
            onChange={(event) => onUpdate(filter.field, { operator: event.target.value })}
          >
            {FILTER_OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={filter.value}
            step={filter.field === "share_rate" || filter.field === "engagement_rate" ? "0.01" : "1"}
            min="0"
            onChange={(event) => onUpdate(filter.field, { value: Number(event.target.value) })}
          />
        </div>
      )}
      <button className="removeSignal" onClick={() => onRemove(filter.field)}>
        Remove
      </button>
    </div>
  );
}

function CreatorModal({ creator, videos, loading, onClose }) {
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <section className="creatorModal" onClick={(event) => event.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <p className="eyebrow">Creator detail</p>
            <h2>{creator.author_name}</h2>
            <p>
              {creator.video_count} trending video{creator.video_count === 1 ? "" : "s"} in this
              dataset. Ranked by the current answer criteria.
            </p>
          </div>
          <button className="closeButton" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modalMetrics">
          <MetricPill label="Views" value={compact(creator.total_views)} />
          <MetricPill label="Engagement" value={compact(creator.engagement_score)} />
          <MetricPill label="Shares" value={compact(creator.total_shares)} />
          <MetricPill label="Hit rate" value={percent(creator.hit_rate)} />
        </div>

        {loading ? (
          <LoadingAnswer />
        ) : (
          <div className="videoList">
            {videos.map((video, index) => (
              <article className="videoRow" key={video.video_id}>
                <div className="videoRank">#{index + 1}</div>
                <div>
                  <h3>{video.caption || "Untitled video"}</h3>
                  <p>
                    {video.upload_date} · {video.duration_sec}s ·{" "}
                    {video.music_is_original ? "original music" : "licensed/sourced music"}
                  </p>
                  <div className="meta">
                    {video.primary_hashtag && <span>#{video.primary_hashtag}</span>}
                    {video.music_name && <span>{video.music_name}</span>}
                  </div>
                </div>
                <dl>
                  <Metric label="Views" value={compact(video.views)} />
                  <Metric label="Likes" value={compact(video.likes)} />
                  <Metric label="Comments" value={compact(video.comments)} />
                  <Metric label="Shares" value={compact(video.shares)} />
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function MetricPill({ label: metricLabel, value }) {
  return (
    <div className="metricPill">
      <span>{metricLabel}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LoadingAnswer({ compact = false }) {
  return (
    <div className={compact ? "loadingAnswer compact" : "loadingAnswer"}>
      <span className="spinner" />
      <div>
        <strong>Generating answer</strong>
        {!compact && <p>Planning the query, running safe metrics, and ranking matching creators.</p>}
      </div>
    </div>
  );
}

function Metric({ label: metricLabel, value }) {
  return (
    <>
      <dt>{metricLabel}</dt>
      <dd>{value}</dd>
    </>
  );
}

function Caveats({ caveats }) {
  if (!caveats.length) return null;
  return (
    <aside className="caveats">
      <strong>Accuracy guardrails</strong>
      {caveats.map((caveat) => (
        <p key={caveat}>{caveat}</p>
      ))}
    </aside>
  );
}

function HealthPill({ health }) {
  if (!health) {
    return (
      <div className="statusPill">
        <span className="statusDot" />
        <span className="statusText">
          <span className="statusProvider">Model</span>
          <span className="statusModel">checking…</span>
        </span>
      </div>
    );
  }
  const llm = health.llm || {};
  const providerLabel = llm.provider === "anthropic" ? "Claude" : "Ollama";
  const ready = Boolean(llm.ok) && llm.modelAvailable !== false;
  const detail = ready ? llm.model || "ready" : "needs setup";
  return (
    <div
      className={`statusPill ${ready ? "ok" : "warn"}`}
      title={health.note || `${providerLabel} — ${detail}`}
    >
      <span className="statusDot" />
      <span className="statusText">
        <span className="statusProvider">{providerLabel}</span>
        <span className="statusModel">{detail}</span>
      </span>
    </div>
  );
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function label(value) {
  return value.replaceAll("_", " ");
}

function compact(value) {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function percent(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function summaryMetric(key, creator) {
  const values = {
    promising: percent(creator.promising_score),
    undiscovered: percent(creator.undiscovered_score),
    engagement: compact(creator.engagement_score),
    viral: compact(creator.total_shares),
    prolific: `${creator.video_count} videos`
  };
  return values[key] || compact(creator.total_views);
}
