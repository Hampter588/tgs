import React, { useEffect, useState, useRef } from "react";
import { X, Check, ArrowUpRight, Leaf } from "lucide-react";
import { api, send, setToken, platform } from "./api";
import MobilePlus from "./MobilePlus";
export default function Dialog({
  modal: m,
  close,
  user,
  formats,
  decks,
  config,
  changed,
  notify,
  setUser,
}) {
  const ref = useRef(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [items, setItems] = useState([]),
    [billing, setBilling] = useState(null),
    [checkout, setCheckout] = useState(null);
  useEffect(() => {
    const prev = document.activeElement,
      el = ref.current;
    el.querySelector("input,textarea,select,button")?.focus();
    const key = (e) => {
      if (e.key === "Escape" && !busy) close();
      if (e.key === "Tab") {
        const c = [
          ...el.querySelectorAll(
            "button:not(:disabled),input,textarea,select,a[href]",
          ),
        ];
        if (e.shiftKey && document.activeElement === c[0]) {
          e.preventDefault();
          c.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === c.at(-1)) {
          e.preventDefault();
          c[0]?.focus();
        }
      }
    };
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("keydown", key);
      prev?.focus();
    };
  }, []);
  async function load() {
    if (m.type === "comments")
      setItems(await api(`/posts/${m.post.id}/comments`));
    if (m.type === "groupChat")
      setItems(await api(`/groups/${m.group.id}/messages`));
    if (m.type === "plus") setBilling(await api("/billing/status"));
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const t = ["comments", "groupChat"].includes(m.type)
      ? setInterval(() => load().catch(() => {}), 15000)
      : null;
    return () => clearInterval(t);
  }, []);
  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e) {
    e.preventDefault();
    const form = e.currentTarget,
      d = Object.fromEntries(new FormData(form));
    await run(async () => {
      const routes = {
        post: "/posts",
        game: "/games",
        group: "/groups",
        deck: "/decks",
        history: "/history",
        verify: "/auth/verify",
      };
      if (m.type === "post") d.deck_id = d.deck_id || null;
      if (m.type === "game")
        d.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (m.type === "history") {
        d.deck_id = d.deck_id || null;
        d.played_at = new Date(d.played_at).toISOString();
      }
      if (routes[m.type]) await send(routes[m.type], d);
      if (m.type === "editDeck") await send(`/decks/${m.deck.id}`, d, "PUT");
      if (m.type === "profile") setUser(await send("/profile", d, "PATCH"));
      if (m.type === "comments" || m.type === "groupChat") {
        await send(
          m.type === "comments"
            ? `/posts/${m.post.id}/comments`
            : `/groups/${m.group.id}/messages`,
          d,
        );
        form.reset();
        await load();
        await changed();
        return;
      }
      if (m.type === "report")
        await send("/reports", {
          ...d,
          target_type: m.target_type,
          target_id: m.target_id,
        });
      if (m.type === "block")
        await send(`/blocks/${m.target.id}`, { blocked: true }, "PUT");
      const remove = {
        deletePost: "posts",
        cancelGame: "games",
        deleteGroup: "groups",
      }[m.type];
      if (remove) await api(`/${remove}/${m.id}`, { method: "DELETE" });
      if (m.type === "moderate")
        await send(
          `/admin/${m.resource}/${m.target.id}/${m.operation}`,
          m.operation === "ban"
            ? { banned: m.enabled, reason: d.reason }
            : { deleted: m.enabled, reason: d.reason },
          "PUT",
        );
      if (m.type === "reviewReport")
        await send(`/admin/reports/${m.report.id}`, d, "PUT");
      if (m.type === "deleteAccount") {
        await api("/account", {
          method: "DELETE",
          body: { ...d, confirm: "DELETE" },
        });
        setToken(null);
        setUser(null);
        close();
        return;
      }
      await changed();
      close();
    });
  }
  const title = {
    post: "Share with your gathering",
    game: "Make room for a game",
    group: "Start a playgroup",
    deck: "Add a deck",
    editDeck: "Your deck",
    profile: "Your player profile",
    comments: "Around the table",
    groupChat: m.group?.name,
    plus: "More of what you love.",
    deckView: m.deck?.name,
    report: "Report to moderators",
    block: `Block ${m.target?.name}?`,
    deletePost: "Delete your post?",
    cancelGame: "Cancel this game?",
    deleteGroup: "Delete this playgroup?",
    history: "Remember a game",
    verify: "Verify your email",
    moderate: "Moderate community",
    reviewReport: "Review report",
    deleteAccount: "Delete your account?",
  }[m.type];
  const field = (label, name, options = {}) => (
    <label>
      {label}
      <input aria-label={label} name={name} {...options} />
    </label>
  );
  const area = (label, name, options = {}) => (
    <label>
      {label}
      <textarea aria-label={label} name={name} {...options} />
    </label>
  );
  const fmt = (value = "Commander") => (
    <label>
      Format
      <select aria-label="Format" name="format" defaultValue={value}>
        {formats.map((f) => (
          <option key={f}>{f}</option>
        ))}
      </select>
    </label>
  );
  const deckSelect = (
    <label>
      Deck
      <select name="deck_id" aria-label="Deck">
        <option value="">No deck</option>
        {decks.map((d) => (
          <option value={d.id} key={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section
        className="modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button
          className="modal-close"
          aria-label="Close dialog"
          onClick={close}
          disabled={busy}
        >
          <X size={20} />
        </button>
        <span className="eyebrow">THE GATHERING SOCIAL</span>
        <h2>{title}</h2>
        {error && (
          <div role="alert" className="notice error">
            {error}
          </div>
        )}
        {m.type === "plus" ? (
          <>
            <p className="muted">
              Always ad-free, whether you subscribe or not.
            </p>
            {[
              [
                "Game history & stats",
                "Log games and see how your decks perform.",
              ],
              [
                "Deck revision history",
                "Save earlier versions and notes when you update a deck.",
              ],
              [
                "Your profile, your style",
                "Choose your profile’s color theme.",
              ],
            ].map(([a, b]) => (
              <div className="plus-feature" key={a}>
                <Check size={18} />
                <div>
                  <b>{a}</b>
                  <p>{b}</p>
                </div>
              </div>
            ))}
            {billing?.plus && (
              <div className="notice">
                Plus is active.
                {billing.subscriptions
                  .filter(
                    (s) => s.status === "active" || s.status === "trialing",
                  )
                  .map((s, i) => (
                    <p key={i}>
                      {s.cancel_at_period_end ? "Ends" : "Renews"}{" "}
                      {new Date(s.period_end * 1000).toLocaleDateString()}
                    </p>
                  ))}
              </div>
            )}
            {["ios", "android"].includes(platform) ? (
              <MobilePlus user={user} config={config} changed={changed} />
            ) : billing?.ready ? (
              <div className="stack-buttons">
                {billing.subscriptions.some(
                  (s) =>
                    s.provider === "stripe" &&
                    !["canceled", "incomplete_expired"].includes(s.status),
                ) ? (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      run(async () =>
                        setCheckout(await send("/billing/portal", {})),
                      )
                    }
                  >
                    Manage subscription
                  </button>
                ) : (
                  <>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        run(async () =>
                          setCheckout(
                            await send("/billing/checkout", {
                              interval: "month",
                            }),
                          ),
                        )
                      }
                    >
                      Subscribe monthly
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(async () =>
                          setCheckout(
                            await send("/billing/checkout", {
                              interval: "year",
                            }),
                          ),
                        )
                      }
                    >
                      Subscribe yearly
                    </button>
                  </>
                )}
                <p className="muted">
                  Price, currency, and recurring billing terms appear in secure
                  checkout before you pay.
                </p>
              </div>
            ) : (
              <div className="notice">
                Subscriptions are not yet enabled on this server. No payment can
                be collected.
              </div>
            )}
            {checkout && (
              <a
                className="primary full"
                target="_blank"
                rel="noopener noreferrer"
                href={checkout.url}
              >
                Open secure billing
                <ArrowUpRight size={15} />
              </a>
            )}
            <button
              className="secondary full"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await send(
                    ["ios", "android"].includes(platform)
                      ? "/billing/store-sync"
                      : "/billing/refresh",
                    {},
                  );
                  await load();
                  await changed();
                })
              }
            >
              Refresh membership
            </button>
          </>
        ) : m.type === "deckView" ? (
          <>
            <div className="deck-art forest">
              <Leaf size={70} />
            </div>
            <p className="muted">{m.deck.commander}</p>
            <pre className="decklist-view">{m.deck.list}</pre>
          </>
        ) : (
          <form onSubmit={submit}>
            {m.type === "post" && (
              <>
                {area("What’s on your mind?", "text", {
                  required: true,
                  maxLength: 4000,
                })}
                <div className="form-row">
                  {fmt()}
                  <label>
                    Post type
                    <select name="type" aria-label="Post type">
                      <option>Discussion</option>
                      <option>Game recap</option>
                      <option>Deck showcase</option>
                    </select>
                  </label>
                </div>
                {deckSelect}
              </>
            )}
            {m.type === "game" && (
              <>
                {field("Game title", "title", {
                  required: true,
                  maxLength: 100,
                })}
                {field("Public venue or general area", "location", {
                  required: true,
                  maxLength: 120,
                })}
                <div className="form-row">
                  {field("Date", "date", { type: "date", required: true })}
                  {field("Time", "time", { type: "time", required: true })}
                </div>
                <div className="form-row">
                  {fmt()}
                  {field("Total seats", "capacity", {
                    type: "number",
                    required: true,
                    min: 2,
                    max: 64,
                    defaultValue: 4,
                  })}
                </div>
                {area("Table preferences", "description", { maxLength: 1000 })}
                <p className="muted">
                  Times use {Intl.DateTimeFormat().resolvedOptions().timeZone}.
                </p>
              </>
            )}
            {m.type === "group" && (
              <>
                {field("Group name", "name", { required: true, maxLength: 60 })}
                {area("Description", "description", { maxLength: 1000 })}
              </>
            )}
            {["deck", "editDeck"].includes(m.type) && (
              <>
                {field("Deck name", "name", {
                  required: true,
                  maxLength: 100,
                  defaultValue: m.deck?.name,
                })}
                {fmt(m.deck?.format)}
                {field("Commander or centerpiece", "commander", {
                  maxLength: 120,
                  defaultValue: m.deck?.commander,
                })}
                {area("Decklist", "list", {
                  className: "decklist-input",
                  required: true,
                  maxLength: 30000,
                  defaultValue: m.deck?.list,
                })}
                {area("Revision note", "note", {
                  maxLength: 1000,
                  placeholder: "What changed and why?",
                })}
                {m.deck && user.plus && (
                  <button
                    type="button"
                    className="secondary full"
                    onClick={() =>
                      run(async () =>
                        setItems(await api(`/decks/${m.deck.id}/versions`)),
                      )
                    }
                  >
                    Load revision history
                  </button>
                )}
                {items.map((v) => (
                  <details className="version" key={v.id}>
                    <summary>
                      {v.created_at} · {v.name}
                    </summary>
                    <p>{v.note}</p>
                    <pre className="decklist-view">{v.list}</pre>
                  </details>
                ))}
                {m.deck && (
                  <button
                    type="button"
                    className="danger-link"
                    onClick={() => {
                      if (confirm("Delete this deck and its history?"))
                        run(async () => {
                          await api(`/decks/${m.deck.id}`, {
                            method: "DELETE",
                          });
                          await changed();
                          close();
                        });
                    }}
                  >
                    Delete deck
                  </button>
                )}
              </>
            )}
            {m.type === "profile" && (
              <>
                {field("Display name", "name", {
                  required: true,
                  maxLength: 60,
                  defaultValue: user.name,
                })}
                {field("Handle", "handle", {
                  required: true,
                  pattern: "[A-Za-z0-9_]{3,30}",
                  defaultValue: user.handle,
                })}
                {area("Bio", "bio", { maxLength: 300, defaultValue: user.bio })}
                {fmt(user.format)}
                <label>
                  Profile theme
                  <select
                    name="theme"
                    aria-label="Profile theme"
                    defaultValue={user.theme}
                  >
                    <option value="purple">Violet</option>
                    <option value="green" disabled={!user.plus}>
                      Forest · Plus
                    </option>
                    <option value="orange" disabled={!user.plus}>
                      Ember · Plus
                    </option>
                    <option value="blue" disabled={!user.plus}>
                      Island · Plus
                    </option>
                  </select>
                </label>
              </>
            )}
            {["comments", "groupChat"].includes(m.type) && (
              <>
                {m.post && <p className="quoted">{m.post.text}</p>}
                <div className="comments">
                  {items.map((c) => (
                    <div key={c.id}>
                      <p>
                        <b>{c.author.name}</b>
                        <span>{c.text}</span>
                        {m.type === "comments" && (
                          <button
                            type="button"
                            className="comment-control"
                            onClick={() =>
                              run(async () => {
                                await send("/reports", {
                                  target_type: "comment",
                                  target_id: c.id,
                                  reason: "Please review this comment.",
                                });
                                notify("Comment reported.");
                              })
                            }
                          >
                            Report
                          </button>
                        )}
                        {m.type === "comments" && c.user_id === user.id && (
                          <button
                            type="button"
                            className="comment-control"
                            onClick={() =>
                              run(async () => {
                                await api(`/comments/${c.id}`, {
                                  method: "DELETE",
                                });
                                await load();
                                await changed();
                              })
                            }
                          >
                            Delete
                          </button>
                        )}
                      </p>
                    </div>
                  ))}
                </div>
                {area("Your reply", "text", {
                  required: true,
                  maxLength: 2000,
                })}
              </>
            )}
            {m.type === "history" && (
              <>
                {deckSelect}
                {fmt()}
                <label>
                  Result
                  <select name="result" aria-label="Result">
                    <option value="win">Win</option>
                    <option value="loss">Loss</option>
                    <option value="draw">Draw</option>
                  </select>
                </label>
                {field("Played at", "played_at", {
                  type: "datetime-local",
                  required: true,
                  defaultValue: new Date(
                    Date.now() - new Date().getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16),
                })}
                {area("Notes", "notes", { maxLength: 2000 })}
              </>
            )}
            {m.type === "report" &&
              area("What should moderators know?", "reason", {
                required: true,
                maxLength: 1000,
              })}
            {m.type === "moderate" && (
              <>
                <p className="muted">
                  {m.resource === "users"
                    ? `${m.enabled ? "Ban" : "Unban"} ${m.target.name}`
                    : `${m.enabled ? "Remove" : "Restore"} content ${m.target.id}`}
                </p>
                {area("Moderation reason", "reason", {
                  required: true,
                  maxLength: 1000,
                })}
              </>
            )}
            {m.type === "reviewReport" && (
              <>
                <p className="quoted">{m.report.reason}</p>
                <label>
                  Status
                  <select
                    name="status"
                    aria-label="Status"
                    defaultValue={m.report.status}
                  >
                    <option>open</option>
                    <option>resolved</option>
                    <option>dismissed</option>
                  </select>
                </label>
                {area("Review notes", "reason", {
                  required: true,
                  maxLength: 1000,
                })}
              </>
            )}
            {m.type === "verify" &&
              field("Verification token", "token", { required: true })}
            {m.type === "deleteAccount" && (
              <>
                <div className="notice">
                  Your web subscription will be canceled. Apple/Google
                  subscriptions must be canceled in store settings; deleting
                  this account cannot cancel them. Your profile, posts, decks,
                  owned groups, and game logs will be deleted. This cannot be
                  undone.
                </div>
                {field("Confirm with your password", "password", {
                  type: "password",
                  required: true,
                  minLength: 12,
                })}
              </>
            )}
            {["deletePost", "cancelGame", "deleteGroup"].includes(m.type) && (
              <p className="muted">
                This removes the item from your gathering. Confirm to continue.
              </p>
            )}
            {m.type === "block" && (
              <p className="muted">
                Your posts, comments, and hosted games will be hidden from each
                other. You can unblock this player in your profile.
              </p>
            )}
            <button className="primary full" disabled={busy}>
              {busy
                ? "Saving…"
                : m.type === "post"
                  ? "Share post"
                  : ["comments", "groupChat"].includes(m.type)
                    ? "Send reply"
                    : m.type === "game"
                      ? "Create game"
                      : m.type === "deleteAccount"
                        ? "Delete account"
                        : m.type === "block"
                          ? "Block player"
                          : "Save"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
