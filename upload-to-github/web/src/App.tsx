import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, canWrite, MeCtx, useAction, useLoad, words, type Me } from "./ui";
import { Overview } from "./pages/Overview";
import { Inventory } from "./pages/Inventory";
import { Product } from "./pages/Product";
import { Listings } from "./pages/Listings";
import { Review } from "./pages/Review";
import { Sales } from "./pages/Sales";
import { Analytics } from "./pages/Analytics";
import { Activity } from "./pages/Activity";
import { Settings } from "./pages/Settings";

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash || "#/overview");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/overview");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const NAV: { path: string; label: string }[] = [
  { path: "overview", label: "Overview" },
  { path: "inventory", label: "Inventory" },
  { path: "listings", label: "Listings" },
  { path: "review", label: "Review queue" },
  { path: "sales", label: "Sales" },
  { path: "analytics", label: "Analytics" },
  { path: "activity", label: "Activity" },
  { path: "settings", label: "Settings" },
];

const MODE_LABEL: Record<string, string> = { review_only: "Review only", semi_autonomous: "Semi-autonomous", full_autonomous: "Full autonomous" };

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = useLoad<{ needsSetup: boolean }>("/api/auth/setup-state");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", { body: { email, password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="card">
        <div className="body stack">
          <div className="brand" style={{ padding: 0 }}>
            <span className="brand-mark">R</span> Resale Ops
          </div>
          {setup.data?.needsSetup ? (
            <div className="banner warn">
              <span>
                No account exists yet. Set <code>ADMIN_EMAIL</code> and <code>ADMIN_PASSWORD</code> in <code>.env</code> and restart the server.
              </span>
            </div>
          ) : (
            <form className="stack" onSubmit={submit}>
              <label className="field">
                Email
                <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </label>
              <label className="field">
                Password
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
              {error && <div className="banner bad">{error}</div>}
              <button className="primary" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

interface Shell {
  automation: { mode: string; paused: boolean; emergencyStop: boolean; emergencyStopReason: string };
  overview: { attention: { approvals: number; operatorTasks: number; total: number } };
  unreadNotifications: number;
  ai: { provider: string; available: boolean; simulated: boolean };
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const hash = useHash();
  const loadMe = useCallback(async () => {
    try {
      setMe((await api<{ user: Me }>("/api/auth/me")).user);
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => {
    void loadMe();
    const out = () => setMe(null);
    window.addEventListener("rs-unauthenticated", out);
    return () => window.removeEventListener("rs-unauthenticated", out);
  }, [loadMe]);

  if (me === undefined) return <div className="empty">Loading…</div>;
  if (me === null) return <Login onDone={loadMe} />;
  return (
    <MeCtx.Provider value={me}>
      <Frame hash={hash} me={me} onSignOut={() => setMe(null)} />
    </MeCtx.Provider>
  );
}

function Frame({ hash, me, onSignOut }: { hash: string; me: Me; onSignOut: () => void }) {
  const shell = useLoad<Shell>("/api/overview", 8000);
  const [busy, run] = useAction();
  const [route, param] = hash.replace(/^#\//, "").split("/");
  const a = shell.data?.automation;
  const attention = (shell.data?.overview.attention.approvals ?? 0) + (shell.data?.overview.attention.operatorTasks ?? 0);

  const stop = () =>
    run(async () => {
      const reason = window.prompt("Emergency stop: all automatic publishing, price changes and edits will be blocked.\n\nReason (optional):", "");
      if (reason === null) return;
      await api("/api/automation/emergency-stop", { body: { reason } });
      await shell.reload();
      return "Emergency stop engaged";
    });
  const release = () =>
    run(async () => {
      if (!window.confirm("Release the emergency stop and allow automation to resume?")) return;
      await api("/api/automation/release", { body: {} });
      await shell.reload();
      return "Emergency stop released";
    });
  const pause = (paused: boolean) =>
    run(async () => {
      await api("/api/automation/pause", { body: { paused } });
      await shell.reload();
      return paused ? "Automation paused" : "Automation resumed";
    });

  let page;
  switch (route) {
    case "inventory": page = <Inventory />; break;
    case "product": page = <Product id={param ?? ""} />; break;
    case "listings": page = <Listings />; break;
    case "review": page = <Review onChange={shell.reload} />; break;
    case "sales": page = <Sales />; break;
    case "analytics": page = <Analytics />; break;
    case "activity": page = <Activity />; break;
    case "settings": page = <Settings onChange={shell.reload} />; break;
    default: page = <Overview />;
  }
  const active = route === "product" ? "inventory" : route || "overview";

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">R</span> Resale Ops
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <a key={n.path} href={`#/${n.path}`} className={active === n.path ? "active" : ""}>
              {n.label}
              {n.path === "review" && attention > 0 && <span className="count">{attention}</span>}
              {n.path === "activity" && (shell.data?.unreadNotifications ?? 0) > 0 && <span className="count">{shell.data!.unreadNotifications}</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <div>{me.email}</div>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
            <span>{words(me.role)}</span>
            <button
              className="ghost sm"
              onClick={async () => {
                await api("/api/auth/logout", { body: {} }).catch(() => {});
                onSignOut();
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          {a && (
            <>
              <span className={`chip ${a.emergencyStop ? "bad" : a.paused ? "warn" : a.mode === "review_only" ? "" : "ok"}`}>
                {a.emergencyStop ? "Emergency stop" : a.paused ? "Paused" : MODE_LABEL[a.mode]}
              </span>
              {!a.emergencyStop && <span className="muted small">{a.paused ? "Automatic actions are held until you resume." : a.mode === "review_only" ? "Nothing is published without your approval." : "Eligible listings publish automatically; exceptions wait for you."}</span>}
              {a.emergencyStop && <span className="small" style={{ color: "var(--danger)" }}>All automatic and manual publishing is blocked. {a.emergencyStopReason}</span>}
            </>
          )}
          {shell.data?.ai.simulated && <span className="chip sim">Simulated AI</span>}
          {shell.data && !shell.data.ai.available && <span className="chip warn" title="Add ANTHROPIC_API_KEY to enable photo identification">No AI key: manual identification</span>}
          <span className="spacer" />
          {a && canWrite(me) && !a.emergencyStop && (
            <button className="sm" disabled={busy} onClick={() => pause(!a.paused)}>
              {a.paused ? "Resume automation" : "Pause"}
            </button>
          )}
          {a && canWrite(me) && !a.emergencyStop && (
            <button className="stop sm" disabled={busy} onClick={stop}>
              Emergency stop
            </button>
          )}
          {a?.emergencyStop && (
            <button className="sm" disabled={busy || me.role !== "owner"} onClick={release} title={me.role !== "owner" ? "Only an owner can release the stop" : ""}>
              Release stop
            </button>
          )}
        </div>
        <div className="page">{page}</div>
      </div>
    </div>
  );
}
