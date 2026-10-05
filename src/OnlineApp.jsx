import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Home,
  Users,
  CalendarDays,
  Layers,
  Sparkles,
  Search,
  Plus,
  Heart,
  MessageCircle,
  Bookmark,
  ArrowUpRight,
  X,
  MapPin,
  Clock,
  ChevronRight,
  Check,
  Settings,
  Download,
  Shield,
  Leaf,
  Flame,
  Droplets,
  Sun,
  Moon,
  LogOut,
  Flag,
  Trash2,
  RefreshCw,
  History,
} from "lucide-react";
import { api, send, setToken, setServerUrl, serverUrl, platform } from "./api";
import "./styles.css";
import "./online.css";
import Dialog from "./Dialog";
const defaultFormats = [
  "Commander",
  "Standard",
  "Modern",
  "Pioneer",
  "Legacy",
  "Vintage",
  "Pauper",
  "Limited",
  "Brawl",
  "Historic",
  "Timeless",
  "Explorer",
  "Alchemy",
  "Oathbreaker",
  "Premodern",
  "Canadian Highlander",
  "Other",
];
const navigation = [
  ["Feed", Home],
  ["Find a game", CalendarDays],
  ["Playgroups", Users],
  ["My decks", Layers],
  ["Game history", History],
  ["My profile", Settings],
];
function Avatar({ user, small = false }) {
  return (
    <span
      className={`avatar ${user?.theme || "purple"} ${small ? "small" : ""}`}
    >
      {(user?.name || "TGS")
        .split(" ")
        .map((x) => x[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}
function Format({ formats, value = "Commander" }) {
  return (
    <label>
      Format
      <select aria-label="Format" name="format" defaultValue={value}>
        {formats.map((f) => (
          <option key={f}>{f}</option>
        ))}
      </select>
    </label>
  );
}
function App() {
  const [user, setUser] = useState(null),
    [config, setConfig] = useState({ formats: defaultFormats }),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("Feed"),
    [modal, setModal] = useState(null),
    [message, setMessage] = useState(""),
    [filter, setFilter] = useState("All formats"),
    [search, setSearch] = useState(""),
    [saved, setSaved] = useState(false),
    [posts, setPosts] = useState([]),
    [hasMore, setHasMore] = useState(false),
    [feedPage, setFeedPage] = useState(0),
    [games, setGames] = useState([]),
    [groups, setGroups] = useState([]),
    [decks, setDecks] = useState([]),
    [logs, setLogs] = useState([]),
    [blocked, setBlocked] = useState([]),
    [adminData, setAdminData] = useState(null),
    [busy, setBusy] = useState(false);
  const params = new URLSearchParams(location.search);
  const [authMode, setAuthMode] = useState(
    params.has("reset") ? "reset" : params.has("verify") ? "verify" : "login",
  );
  const [linkToken] = useState(
    params.get("reset") || params.get("verify") || "",
  );
  function notify(text) {
    setMessage(text);
  }
  async function authenticate(data) {
    setToken(data.token);
    setConfig(await api("/config"));
    setUser(data.user);
    setMessage(data.message || "");
    await refresh(data.user);
  }
  async function refresh(current = user) {
    if (!current) return;
    const [gs, gr, ds] = await Promise.all([
      api("/games"),
      api("/groups"),
      api("/decks"),
    ]);
    setGames(gs);
    setGroups(gr);
    setDecks(ds);
    const me = await api("/auth/me");
    setUser(me);
  }
  async function loadFeed(index = 0, append = false) {
    const q = new URLSearchParams({
      page: String(index),
      format: filter,
      search,
      saved: String(saved),
    });
    const result = await api(`/posts?${q}`);
    setPosts((v) => (append ? [...v, ...result.items] : result.items));
    setHasMore(result.hasMore);
    setFeedPage(index);
  }
  async function action(fn) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e.message);
      if (
        e.status === 401 ||
        (e.status === 403 && e.message.includes("banned"))
      ) {
        setUser(null);
        setToken(null);
      }
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const c = await api("/config");
        if (live) setConfig(c);
        if (params.has("reset")) return;
        if (params.has("verify")) {
          await send("/auth/verify", { token: params.get("verify") });
          history.replaceState(null, "", location.pathname);
          if (live) setMessage("Email verified.");
        }
        const me = await api("/auth/me");
        if (live) {
          setUser(me);
          await refresh(me);
        }
      } catch (e) {
        if (e.status !== 401 && live) setMessage(e.message);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      action(async () => {
        if (page === "Feed") await loadFeed();
        else if (page === "Game history" && user.plus)
          setLogs(await api("/history"));
        else if (page === "Admin") setAdminData(await api("/admin"));
        else if (page === "My profile") setBlocked(await api("/blocks"));
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [user?.id, page, filter, search, saved]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        api("/auth/me")
          .then(setUser)
          .catch((e) => {
            if (e.status === 401 || e.status === 403) {
              setUser(null);
              setToken(null);
              notify(e.message);
            }
          });
        if (page === "Feed") loadFeed().catch(() => {});
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [user?.id, page, filter, search, saved]);
  async function changed() {
    await refresh();
    if (page === "Feed") await loadFeed();
    if (page === "Admin") setAdminData(await api("/admin"));
    if (page === "Game history" && user.plus) setLogs(await api("/history"));
    notify("Saved to your gathering.");
  }
  async function logout() {
    await send("/auth/logout", {});
    setToken(null);
    setUser(null);
    setPosts([]);
    setPage("Feed");
  }
  async function exportData() {
    const data = await api("/account/export");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "tgs-account.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  const formats = config.formats || defaultFormats;
  if (loading)
    return (
      <div className="auth-shell">
        <span className="brand-mark">✦</span>
        <p>Connecting to your gathering…</p>
      </div>
    );
  if (!user)
    return (
      <Auth
        mode={authMode}
        setMode={setAuthMode}
        token={linkToken}
        message={message}
        notify={notify}
        onLogin={authenticate}
      />
    );
  const nav =
    user.role === "admin" ? [...navigation, ["Admin", Shield]] : navigation;
  const matchingGames = games.filter(
    (g) =>
      (filter === "All formats" || g.format === filter) &&
      `${g.title} ${g.location}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className={`app-shell theme-${user.theme}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => setPage("Feed")}>
          <span className="brand-mark">✦</span>
          <span>
            TGS<span className="brand-caption">THE GATHERING SOCIAL</span>
          </span>
        </button>
        <div className="nav-caption">YOUR GATHERING</div>
        <nav>
          {nav.map(([label, Icon]) => (
            <button
              key={label}
              className={`nav-item ${page === label ? "active" : ""}`}
              onClick={() => {
                setPage(label);
                setSearch("");
              }}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-caption">YOUR PLAYGROUPS</div>
        {groups
          .filter((g) => g.joined)
          .slice(0, 3)
          .map((g) => (
            <button
              className="group-link"
              key={g.id}
              onClick={() => setModal({ type: "groupChat", group: g })}
            >
              <span className="group-dot" />
              {g.name}
            </button>
          ))}
        <div className="plus-teaser">
          <Sparkles size={20} />
          <h3>
            {user.plus ? "Your gathering, upgraded." : "A little more magic."}
          </h3>
          <p>Game history. Deck revisions. Your style.</p>
          <button onClick={() => setModal({ type: "plus" })}>
            {user.plus ? "Manage Plus" : "Explore Plus"}
            <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <span>
            <Shield size={13} />
            Always ad-free.
          </span>
          <button className="account" onClick={() => setPage("My profile")}>
            <Avatar user={user} />
            <span>
              <b>{user.name}</b>
              <small>@{user.handle}</small>
            </span>
            <ChevronRight size={16} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Your community
            <ChevronRight size={13} />
            <span>{page}</span>
          </div>
          <label className="search">
            <Search size={17} />
            <input
              aria-label="Search community"
              placeholder="Search your gathering…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <button
            className="primary compact"
            onClick={() => setModal({ type: "post" })}
          >
            <Plus size={17} />
            Create post
          </button>
        </header>
        <div className="local-banner">
          <span className="status-dot" />
          Connected to TGS · {user.plus ? "Plus member" : "Free member"} · no
          ads{busy && " · syncing…"}
        </div>
        {!user.verified && config.requireVerification && (
          <div className="notice verification">
            Verify your email to participate.
            <button
              className="secondary"
              onClick={() =>
                action(async () => {
                  const r = await send("/auth/resend", {});
                  notify(r.message);
                })
              }
            >
              Resend email
            </button>
            <button
              className="secondary"
              onClick={() => setModal({ type: "verify" })}
            >
              Enter verification token
            </button>
          </div>
        )}
        {message && (
          <div className="message-bar" role="status">
            {message}
            <button aria-label="Dismiss message" onClick={() => setMessage("")}>
              <X size={16} />
            </button>
          </div>
        )}
        <div className="content-layout">
          <main>
            <section className="page-heading">
              <span className="eyebrow">A PLACE AT THE TABLE</span>
              <h1>
                {
                  {
                    Feed: "Good people. Great games.",
                    "Find a game": "Your next game starts here.",
                    Playgroups: "Find your kind of gathering.",
                    "My decks": "Every deck has a story.",
                    "Game history": "Remember the good games.",
                    "My profile": "Make yourself at home.",
                    Admin: "Care for the community.",
                  }[page]
                }
              </h1>
              <p>
                Different formats. Familiar faces. The same love of the game.
              </p>
            </section>
            {(page === "Feed" || page === "Find a game") && (
              <div className="format-list">
                {["All formats", ...formats.slice(0, 8)].map((f) => (
                  <button
                    className={filter === f ? "selected" : ""}
                    key={f}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
                <select
                  aria-label="More formats"
                  value={formats.slice(8).includes(filter) ? filter : ""}
                  onChange={(e) => setFilter(e.target.value || "All formats")}
                >
                  <option value="">More formats</option>
                  {formats.slice(8).map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </div>
            )}
            {page === "Feed" && (
              <>
                <button
                  className="composer"
                  onClick={() => setModal({ type: "post" })}
                >
                  <Avatar user={user} />
                  <span>What’s happening in your corner of Magic?</span>
                  <Plus size={19} />
                </button>
                <div className="feed-tabs">
                  <button
                    className={!saved ? "active" : ""}
                    onClick={() => setSaved(false)}
                  >
                    Latest
                  </button>
                  <button
                    className={saved ? "active" : ""}
                    onClick={() => setSaved(true)}
                  >
                    Saved
                  </button>
                  <button onClick={() => action(() => loadFeed())}>
                    <RefreshCw size={13} /> Refresh
                  </button>
                  <span>All formats. One community.</span>
                </div>
                {posts.map((p) => (
                  <article className="post" key={p.id}>
                    <div className="post-top">
                      <Avatar user={p.author} />
                      <div>
                        <b>{p.author.name}</b>
                        <small>
                          @{p.author.handle} ·{" "}
                          {new Date(p.created_at + "Z").toLocaleDateString()}
                        </small>
                      </div>
                      <span className="format-tag">{p.format}</span>
                    </div>
                    <span className="post-type">{p.type}</span>
                    <p className="post-copy">{p.text}</p>
                    {p.deck && (
                      <button
                        className="deck-feature"
                        onClick={() =>
                          setModal({ type: "deckView", deck: p.deck })
                        }
                      >
                        <div className="deck-art forest">
                          <div className="orbit one" />
                          <Leaf size={65} strokeWidth={1} />
                        </div>
                        <div className="deck-caption">
                          <div>
                            <small>{p.deck.format.toUpperCase()} DECK</small>
                            <h3>{p.deck.name}</h3>
                            <p>{p.deck.commander}</p>
                          </div>
                          <ArrowUpRight size={20} />
                        </div>
                      </button>
                    )}
                    <div className="post-actions">
                      <button
                        className={p.liked ? "is-liked" : ""}
                        aria-label={`Like post by ${p.author.name}`}
                        onClick={() =>
                          action(async () => {
                            await send(
                              `/posts/${p.id}/like`,
                              { enabled: !p.liked },
                              "PUT",
                            );
                            await loadFeed();
                          })
                        }
                      >
                        <Heart
                          size={18}
                          fill={p.liked ? "currentColor" : "none"}
                        />
                        {p.likes}
                      </button>
                      <button
                        onClick={() => setModal({ type: "comments", post: p })}
                      >
                        <MessageCircle size={18} />
                        {p.comments}
                        <span>Discuss</span>
                      </button>
                      <button
                        aria-label="Report post"
                        onClick={() =>
                          setModal({
                            type: "report",
                            target_type: "post",
                            target_id: p.id,
                          })
                        }
                      >
                        <Flag size={16} />
                      </button>
                      {p.user_id === user.id ? (
                        <button
                          aria-label="Delete my post"
                          onClick={() =>
                            setModal({ type: "deletePost", id: p.id })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      ) : (
                        <button
                          aria-label={`Block ${p.author.name}`}
                          onClick={() =>
                            setModal({ type: "block", target: p.author })
                          }
                        >
                          <Shield size={16} />
                        </button>
                      )}
                      <button
                        className={`bookmark ${p.saved ? "is-saved" : ""}`}
                        aria-label={`Save post by ${p.author.name}`}
                        onClick={() =>
                          action(async () => {
                            await send(
                              `/posts/${p.id}/bookmark`,
                              { enabled: !p.saved },
                              "PUT",
                            );
                            await loadFeed();
                          })
                        }
                      >
                        <Bookmark
                          size={18}
                          fill={p.saved ? "currentColor" : "none"}
                        />
                      </button>
                    </div>
                  </article>
                ))}
                {!posts.length && (
                  <div className="empty">
                    No posts yet. Start a conversation.
                  </div>
                )}
                {hasMore && (
                  <button
                    className="secondary full"
                    onClick={() => action(() => loadFeed(feedPage + 1, true))}
                  >
                    Load more posts
                  </button>
                )}
              </>
            )}
            {page === "Find a game" && (
              <>
                <div className="section-toolbar">
                  <h2>Open tables</h2>
                  <button
                    className="primary"
                    onClick={() => setModal({ type: "game" })}
                  >
                    <Plus size={16} />
                    Host a game
                  </button>
                </div>
                {matchingGames.map((g) => (
                  <article className="game-card" key={g.id}>
                    <div className="game-symbol purple">
                      <CalendarDays size={25} />
                    </div>
                    <div className="game-info">
                      <span className="format-tag">{g.format}</span>
                      <h2>{g.title}</h2>
                      <p>{g.description}</p>
                      <div className="game-meta">
                        <span>
                          <MapPin size={14} />
                          {g.location}
                        </span>
                        <span>
                          <Clock size={14} />
                          {g.date} · {g.time} ({g.timezone})
                        </span>
                      </div>
                    </div>
                    <div className="game-join">
                      <small>
                        {g.attendees}/{g.capacity} players
                      </small>
                      <button
                        disabled={
                          busy || (!g.joined && g.attendees >= g.capacity)
                        }
                        className={g.joined ? "secondary" : "primary"}
                        onClick={() =>
                          action(async () => {
                            await send(
                              `/games/${g.id}/rsvp`,
                              { joined: !g.joined },
                              "PUT",
                            );
                            await refresh();
                          })
                        }
                      >
                        {g.joined
                          ? "Leave table"
                          : g.attendees >= g.capacity
                            ? "Table full"
                            : "Join table"}
                      </button>
                      {g.host_id === user.id && (
                        <button
                          className="danger-link"
                          onClick={() =>
                            setModal({ type: "cancelGame", id: g.id })
                          }
                        >
                          Cancel game
                        </button>
                      )}
                    </div>
                  </article>
                ))}
                {!matchingGames.length && (
                  <div className="empty">
                    No matching games. Host a new table.
                  </div>
                )}
              </>
            )}
            {page === "Playgroups" && (
              <>
                <div className="section-toolbar">
                  <h2>Your people</h2>
                  <button
                    className="primary"
                    onClick={() => setModal({ type: "group" })}
                  >
                    <Plus size={16} />
                    Create group
                  </button>
                </div>
                {groups
                  .filter((g) =>
                    `${g.name} ${g.description}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((g) => (
                    <article className="group-card" key={g.id}>
                      <span className="group-emblem purple">
                        <Users size={28} />
                      </span>
                      <div>
                        <h2>{g.name}</h2>
                        <p>{g.description}</p>
                        <span className="muted">{g.members} members</span>
                      </div>
                      <div className="stack-buttons">
                        {g.joined && (
                          <button
                            className="primary"
                            onClick={() =>
                              setModal({ type: "groupChat", group: g })
                            }
                          >
                            Open conversation
                          </button>
                        )}
                        {g.owner_id === user.id ? (
                          <button
                            className="danger-link"
                            onClick={() =>
                              setModal({ type: "deleteGroup", id: g.id })
                            }
                          >
                            Delete group
                          </button>
                        ) : (
                          <button
                            className="secondary"
                            onClick={() =>
                              action(async () => {
                                await send(
                                  `/groups/${g.id}/membership`,
                                  { joined: !g.joined },
                                  "PUT",
                                );
                                await refresh();
                              })
                            }
                          >
                            {g.joined ? "Leave group" : "Join group"}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                {!groups.length && (
                  <div className="empty">Make a home for your playgroup.</div>
                )}
              </>
            )}
            {page === "My decks" && (
              <>
                <div className="section-toolbar">
                  <h2>Your deck shelf · {decks.length}</h2>
                  <button
                    className="primary"
                    onClick={() => setModal({ type: "deck" })}
                  >
                    <Plus size={16} />
                    Add deck
                  </button>
                </div>
                <div className="deck-grid">
                  {decks
                    .filter((d) =>
                      `${d.name} ${d.commander}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((d) => (
                      <button
                        className="deck-tile"
                        key={d.id}
                        onClick={() => setModal({ type: "editDeck", deck: d })}
                      >
                        <div className="deck-art forest">
                          <Layers size={60} strokeWidth={1} />
                        </div>
                        <div>
                          <span className="format-tag">{d.format}</span>
                          <h2>{d.name}</h2>
                          <p>{d.commander || "Your next great brew"}</p>
                          <small>
                            View & edit deck <ArrowUpRight size={12} />
                          </small>
                        </div>
                      </button>
                    ))}
                </div>
              </>
            )}
            {page === "Game history" &&
              (user.plus ? (
                <>
                  <div className="section-toolbar">
                    <h2>
                      {logs.length} games ·{" "}
                      {logs.filter((l) => l.result === "win").length} wins
                    </h2>
                    <button
                      className="primary"
                      onClick={() => setModal({ type: "history" })}
                    >
                      <Plus size={15} />
                      Log a game
                    </button>
                  </div>
                  {logs.map((l) => (
                    <article className="game-card" key={l.id}>
                      <div className="game-info">
                        <span className="format-tag">
                          {l.result.toUpperCase()} · {l.format}
                        </span>
                        <h2>{l.deck_name || "A good game"}</h2>
                        <p>{l.notes}</p>
                        <small className="muted">
                          {new Date(l.played_at).toLocaleString()}
                        </small>
                      </div>
                      <button
                        aria-label="Delete game log"
                        onClick={() =>
                          action(async () => {
                            await api(`/history/${l.id}`, { method: "DELETE" });
                            await changed();
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </article>
                  ))}
                </>
              ) : (
                <div className="notice">
                  <h2>Remember every gathering.</h2>
                  <p>
                    Game logging and personal stats are included with TGS Plus.
                  </p>
                  <button
                    className="primary"
                    onClick={() => setModal({ type: "plus" })}
                  >
                    Explore Plus
                  </button>
                </div>
              ))}
            {page === "My profile" && (
              <>
                <section className="profile-card">
                  <div className={`profile-cover ${user.theme}`}>
                    <Sparkles size={60} />
                  </div>
                  <Avatar user={user} />
                  <h2>{user.name}</h2>
                  <p className="muted">
                    @{user.handle} · {user.plus ? "TGS Plus" : "Free member"}
                  </p>
                  <p>{user.bio}</p>
                  <span className="format-tag">{user.format}</span>
                  <div className="profile-stats">
                    <span>
                      <b>{decks.length}</b>Decks
                    </span>
                    <span>
                      <b>{groups.filter((g) => g.joined).length}</b>Playgroups
                    </span>
                  </div>
                  <div className="profile-controls">
                    <button
                      className="primary"
                      onClick={() => setModal({ type: "profile" })}
                    >
                      Edit profile
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setModal({ type: "plus" })}
                    >
                      TGS Plus
                    </button>
                    <button
                      className="secondary"
                      onClick={() => action(exportData)}
                    >
                      <Download size={15} />
                      Export my data
                    </button>
                    <button
                      className="secondary"
                      onClick={() => action(logout)}
                    >
                      <LogOut size={15} />
                      Sign out
                    </button>
                  </div>
                </section>
                <section className="settings-section">
                  <h3>Blocked players</h3>
                  {blocked.length ? (
                    blocked.map((b) => (
                      <div className="section-toolbar" key={b.id}>
                        <span>
                          {b.name} · @{b.handle}
                        </span>
                        <button
                          className="secondary"
                          onClick={() =>
                            action(async () => {
                              await send(
                                `/blocks/${b.id}`,
                                { blocked: false },
                                "PUT",
                              );
                              setBlocked(await api("/blocks"));
                            })
                          }
                        >
                          Unblock
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted">You haven’t blocked anyone.</p>
                  )}
                  <h3>Account controls</h3>
                  <button
                    className="secondary"
                    onClick={() => setModal({ type: "deleteAccount" })}
                  >
                    Delete my account
                  </button>
                  {user.role === "admin" && (
                    <button
                      className="secondary"
                      onClick={() => setPage("Admin")}
                    >
                      Open admin panel
                    </button>
                  )}
                  <button
                    className="secondary"
                    onClick={() => setPage("Game history")}
                  >
                    Game history
                  </button>
                </section>
              </>
            )}
            {page === "Admin" && user.role === "admin" && (
              <Admin data={adminData} open={setModal} />
            )}
          </main>
          <aside className="right-rail">
            <section className="welcome-card">
              <span className="eyebrow">THE GATHERING IS THE POINT</span>
              <div className="welcome-stars">
                ✦ <span>✧</span>
              </div>
              <h2>
                There’s always room
                <br />
                for one more.
              </h2>
              <p>
                Different decks. Different formats.
                <br />
                The same love of the game.
              </p>
              <button onClick={() => setPage("Playgroups")}>
                Find your people
                <ArrowUpRight size={15} />
              </button>
            </section>
            <section className="rail-section">
              <div className="rail-title">
                <h3>Pull up a chair</h3>
                <button onClick={() => setPage("Find a game")}>
                  <ArrowUpRight size={17} />
                </button>
              </div>
              {games.slice(0, 3).map((g) => (
                <button
                  className="mini-game"
                  key={g.id}
                  onClick={() => {
                    setPage("Find a game");
                    setFilter(g.format);
                  }}
                >
                  <span className="mini-date purple">
                    <b>{g.date.slice(-2)}</b>
                    <small>
                      {new Date(g.date + "T12:00:00")
                        .toLocaleDateString("en", { month: "short" })
                        .toUpperCase()}
                    </small>
                  </span>
                  <span>
                    <b>{g.title}</b>
                    <small>
                      {g.format} · {g.capacity - g.attendees} seats open
                    </small>
                  </span>
                </button>
              ))}
              {!games.length && (
                <p className="muted">
                  Your community’s next table could be yours.
                </p>
              )}
            </section>
            <section className="rail-section">
              <h3>Five colors. Endless stories.</h3>
              <div className="color-icons">
                <Sun />
                <Droplets />
                <Moon />
                <Flame />
                <Leaf />
              </div>
              <p className="rail-copy">
                The best part of Magic has always been the people across the
                table.
              </p>
            </section>
            <footer>
              Community-first. Always ad-free.
              <br />
              <span>
                Independent fan project · Not affiliated with Wizards of the
                Coast.
              </span>
            </footer>
          </aside>
        </div>
      </div>
      <nav className="mobile-nav">
        {navigation.slice(0, 4).map(([label, Icon]) => (
          <button
            key={label}
            className={page === label ? "active" : ""}
            onClick={() => setPage(label)}
          >
            <Icon size={21} />
            <span>
              {label === "Find a game"
                ? "Games"
                : label === "My decks"
                  ? "Decks"
                  : label}
            </span>
          </button>
        ))}
        <button
          className={page === "My profile" ? "active" : ""}
          onClick={() => setPage("My profile")}
        >
          <Settings size={21} />
          <span>Profile</span>
        </button>
      </nav>
      {modal && (
        <Dialog
          key={`${modal.type}-${modal.id || modal.post?.id || ""}`}
          modal={modal}
          close={() => setModal(null)}
          user={user}
          formats={formats}
          decks={decks}
          config={config}
          changed={changed}
          notify={notify}
          setUser={setUser}
          setPage={setPage}
        />
      )}
    </div>
  );
}
function Auth({ mode, setMode, token, message, notify, onLogin }) {
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const d = Object.fromEntries(new FormData(e.currentTarget));
      if (mode === "server") {
        setServerUrl(d.server);
        notify("Server updated. Sign in to connect.");
        setMode("login");
      } else if (mode === "login" || mode === "register") {
        const result = await send(`/auth/${mode}`, d);
        await onLogin(result);
        history.replaceState(null, "", location.pathname);
      } else if (mode === "forgot") {
        const r = await send("/auth/forgot", d);
        notify(r.message);
      } else if (mode === "verify") {
        await send("/auth/verify", { token: d.token || token });
        notify("Email verified. Sign in to continue.");
        setMode("login");
        history.replaceState(null, "", location.pathname);
      } else if (mode === "reset") {
        await send("/auth/reset", {
          token: d.token || token,
          password: d.password,
        });
        notify("Password reset. Sign in with your new password.");
        setMode("login");
        history.replaceState(null, "", location.pathname);
      }
    } catch (e) {
      notify(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <section className="auth-card">
        <div className="brand">
          <span className="brand-mark">✦</span>
          <span>
            TGS<span className="brand-caption">THE GATHERING SOCIAL</span>
          </span>
        </div>
        <span className="eyebrow">YOUR PLACE AT THE TABLE</span>
        <h1>
          {
            {
              login: "Welcome to the gathering.",
              register: "Pull up a chair.",
              forgot: "Let’s get you back in.",
              reset: "A fresh start.",
              verify: "Verify your email.",
              server: "Connect your gathering.",
            }[mode]
          }
        </h1>
        <p className="muted">All formats. Good people. Zero ads.</p>
        {message && (
          <div className="notice" role="status">
            {message}
          </div>
        )}
        <form onSubmit={submit}>
          {(mode === "login" || mode === "register" || mode === "forgot") && (
            <label>
              Email
              <input type="email" name="email" required autoComplete="email" />
            </label>
          )}
          {mode === "register" && (
            <>
              <label>
                Display name
                <input name="name" required maxLength={60} />
              </label>
              <label>
                Handle
                <input
                  name="handle"
                  required
                  pattern="[A-Za-z0-9_]{3,30}"
                  title="3–30 letters, numbers, or underscores"
                />
              </label>
            </>
          )}
          {(mode === "login" || mode === "register" || mode === "reset") && (
            <label>
              Password
              <input
                aria-label="Password"
                type="password"
                name="password"
                required
                minLength={mode === "login" ? 1 : 12}
                maxLength={128}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
              {mode !== "login" && <small>At least 12 characters.</small>}
            </label>
          )}
          {(mode === "verify" || mode === "reset") && (
            <label>
              Link token
              <input name="token" defaultValue={token} required />
            </label>
          )}
          {mode === "server" && (
            <label>
              Server URL
              <input
                name="server"
                type="url"
                required
                defaultValue={serverUrl()}
                placeholder="https://tgs.example.com"
              />
            </label>
          )}
          <button className="primary full" disabled={busy}>
            {busy
              ? "Connecting…"
              : {
                  login: "Sign in",
                  register: "Create account",
                  forgot: "Send reset email",
                  reset: "Reset password",
                  verify: "Verify email",
                  server: "Save server",
                }[mode]}
          </button>
        </form>
        <div className="auth-links">
          {mode === "login" ? (
            <>
              <button
                onClick={() => {
                  setMode("register");
                  notify("");
                }}
              >
                Create an account
              </button>
              <button onClick={() => setMode("forgot")}>
                Forgot password?
              </button>
            </>
          ) : (
            <button onClick={() => setMode("login")}>Back to sign in</button>
          )}
          <button onClick={() => setMode("server")}>Server settings</button>
        </div>
        <p className="auth-footer">
          Independent Magic fan community. Not affiliated with Wizards of the
          Coast.
        </p>
      </section>
    </div>
  );
}
function Admin({ data, open }) {
  const [tab, setTab] = useState("Reports"),
    [search, setSearch] = useState("");
  if (!data) return <div className="empty">Loading moderation tools…</div>;
  return (
    <section>
      <div className="notice">
        Admin actions are enforced by the server and recorded in the audit log.
        Bans revoke sessions immediately.
      </div>
      <div className="feed-tabs">
        {["Reports", "Users", "Posts", "Comments", "Audit log"].map((t) => (
          <button
            className={tab === t ? "active" : ""}
            key={t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <label className="admin-search">
        Search this list
        <input value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {tab === "Users" &&
        data.users
          .filter((u) =>
            `${u.name} ${u.email} ${u.handle}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((u) => (
            <article className="admin-row" key={u.id}>
              <div>
                <b>{u.name}</b>
                <small>
                  {u.email} · @{u.handle} · {u.role}
                </small>
                <span className="format-tag">
                  {u.banned ? "Banned" : "Active"}
                </span>
                {u.ban_reason && <p>{u.ban_reason}</p>}
              </div>
              {u.role !== "admin" && (
                <button
                  className="secondary"
                  onClick={() =>
                    open({
                      type: "moderate",
                      resource: "users",
                      target: u,
                      operation: "ban",
                      enabled: !u.banned,
                    })
                  }
                >
                  {u.banned ? "Unban" : "Ban user"}
                </button>
              )}
            </article>
          ))}
      {(tab === "Posts" || tab === "Comments") &&
        data[tab.toLowerCase()]
          .filter((p) =>
            `${p.text} ${p.author}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((p) => (
            <article className="admin-row" key={p.id}>
              <div>
                <b>{p.author}</b>
                <p>{p.text}</p>
                <small>{p.id}</small>
                <span className="format-tag">
                  {p.deleted_at ? "Removed" : "Visible"}
                </span>
              </div>
              <button
                className="secondary"
                onClick={() =>
                  open({
                    type: "moderate",
                    resource: tab.toLowerCase(),
                    target: p,
                    operation: "moderation",
                    enabled: !p.deleted_at,
                  })
                }
              >
                {p.deleted_at ? "Restore" : "Remove"}
              </button>
            </article>
          ))}
      {tab === "Reports" &&
        data.reports
          .filter((r) =>
            `${r.reason} ${r.target_id}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((r) => (
            <article className="admin-row" key={r.id}>
              <div>
                <span className="format-tag">
                  {r.status} · {r.target_type}
                </span>
                <p>{r.reason}</p>
                <small>Target: {r.target_id}</small>
              </div>
              <button
                className="secondary"
                onClick={() => open({ type: "reviewReport", report: r })}
              >
                Review
              </button>
            </article>
          ))}
      {tab === "Audit log" &&
        data.audit
          .filter((a) =>
            `${a.action} ${a.reason}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((a) => (
            <article className="admin-row" key={a.id}>
              <div>
                <b>{a.action}</b>
                <p>{a.reason}</p>
                <small>
                  Actor: {a.actor_id} · Target: {a.target_id}
                  <br />
                  {a.created_at}
                </small>
              </div>
            </article>
          ))}
    </section>
  );
}

// Dialogs are defined below to keep all mutations routed through the server.
createRoot(document.getElementById("root")).render(<App />);
