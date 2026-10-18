"use client";
import { useEffect, useState } from "react";
import { GoogleOAuthProvider, GoogleLogin } from "@react-oauth/google";
const API = process.env.NEXT_PUBLIC_API!;
const RANK: Record<string, number> = { admin: 3, manager: 2, salesperson: 1 };
type Me = { email: string; name: string; role: string };
type Med = { id: number; name: string; batch: string; expiry: string; stock: number; price: number; cost?: number };
type Row = Record<string, any>;
const blank = { name: "", batch: "", expiry: "", stock: "0", cost: "0", price: "0" };
const ld = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const rs = (n: number) => "Rs " + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PH = process.env.NEXT_PUBLIC_PHARMACY_NAME || "Pharmacy";
async function upload(file: File) {
  const r = await fetch(`${API}/medicines/import?filename=${encodeURIComponent(file.name)}`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream", "X-CSRF": "1" }, body: file });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Import failed");
  return d;
}
const mkDash = (rows: { d: string; sales: number; profit?: number }[], top: Record<string, number>) => {
  const days = Array.from({ length: 14 }, (_, i) => ld(new Date(Date.now() - (13 - i) * 864e5)));
  return { days: days.map((d) => { const r = rows.find((x) => x.d === d); return { l: d.slice(5), a: Math.round(r?.sales ?? 0), b: r?.profit === undefined ? undefined : Math.max(0, Math.round(r.profit)) }; }),
    top: Object.entries(top).sort((x, y) => y[1] - x[1]).slice(0, 5) };
};
function Bars({ data }: { data: { l: string; a: number; b?: number }[] }) {
  const W = 600, H = 190, P = 34, mx = Math.max(1, ...data.map((d) => Math.max(d.a, d.b ?? 0))), bw = (W - P) / data.length, y = (v: number) => H - (v / mx) * H * 0.9;
  return (<svg viewBox={`0 0 ${W} ${H + 22}`} style={{ width: "100%" }}>
    {[0, 0.5, 1].map((f) => <g key={f}><line x1={P} x2={W} y1={y(mx * f)} y2={y(mx * f)} stroke="#e2e8f0" /><text x={0} y={y(mx * f) + 4} fontSize="10" fill="#64748b">{Math.round(mx * f)}</text></g>)}
    {data.map((d, i) => (<g key={i}>
      <rect x={P + i * bw + bw * 0.1} y={y(d.a)} width={bw * 0.38} height={H - y(d.a)} rx={3} fill="#0f766e"><title>{`${d.l}: sales ${d.a}`}</title></rect>
      {d.b !== undefined && <rect x={P + i * bw + bw * 0.5} y={y(d.b)} width={bw * 0.38} height={H - y(d.b)} rx={3} fill="#f59e0b"><title>{`${d.l}: profit ${d.b}`}</title></rect>}
      <text x={P + i * bw + bw / 2} y={H + 14} fontSize="9" textAnchor="middle" fill="#64748b">{d.l}</text></g>))}</svg>);
}
function Donut({ parts }: { parts: [string, number, string][] }) {
  const n = parts.reduce((a, p) => a + p[1], 0), C = 2 * Math.PI * 60; let acc = 0;
  return (<div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
    <svg viewBox="0 0 160 160" width={160}><g transform="rotate(-90 80 80)">
      {parts.map(([l, v, c]) => { const len = n ? (v / n) * C : 0; const el = <circle key={l} cx="80" cy="80" r="60" fill="none" stroke={c} strokeWidth="26" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} />; acc += len; return el; })}</g>
      <text x="80" y="87" textAnchor="middle" fontSize="24" fontWeight="700" fill="#0f172a">{n}</text></svg>
    <div>{parts.map(([l, v, c]) => <div key={l} style={{ fontSize: 14, margin: "5px 0" }}><span style={{ display: "inline-block", width: 11, height: 11, borderRadius: 3, background: c, marginRight: 8 }} />{l}: <b>{v}</b></div>)}</div></div>);
}
const NAV: [string, string, string, string][] = [["dashboard", "📊", "Dashboard", "salesperson"], ["inventory", "💊", "Inventory", "salesperson"], ["sales", "🧾", "Sales & Billing", "salesperson"], ["purchases", "📦", "Purchases", "manager"], ["reports", "📈", "Reports", "manager"], ["storage", "💾", "Storage & Backup", "admin"], ["users", "👥", "Users & Roles", "admin"]];
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch(API + path, { method, credentials: "include", headers: { "Content-Type": "application/json", "X-CSRF": "1" }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Please check the entered values");
  return d;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="f">{label}{children}</label>; }
function Table({ rows, cols }: { rows: Row[]; cols: [string, (r: Row) => React.ReactNode][] }) {
  if (!rows.length) return <div className="empty">No records yet.</div>;
  return (<div className="scroll"><table><thead><tr>{cols.map(([h]) => <th key={h}>{h}</th>)}</tr></thead>
    <tbody>{rows.map((r) => <tr key={r.id}>{cols.map(([h, f]) => <td key={h}>{f(r)}</td>)}</tr>)}</tbody></table></div>);
}
export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState("dashboard");
  const [meds, setMeds] = useState<Med[]>([]);
  const [sales, setSales] = useState<Row[]>([]);
  const [purch, setPurch] = useState<Row[]>([]);
  const [users, setUsers] = useState<Row[]>([]);
  const [msg, setMsg] = useState({ t: "", k: "ok" });
  const [q, setQ] = useState("");
  const [flt, setFlt] = useState("all");
  const [form, setForm] = useState<any>(blank);
  const [editId, setEditId] = useState<number | null>(null);
  const [modal, setModal] = useState(false);
  const [sale, setSale] = useState({ mid: "", qty: "1" });
  const [pur, setPur] = useState({ mid: "", qty: "1", supplier: "" });
  const [rq, setRq] = useState({ range: "today", from: ld(new Date()), to: ld(new Date()), group: "hour" });
  const [rep, setRep] = useState<any>(null);
  const [bills, setBills] = useState<Row[]>([]);
  const [bill, setBill] = useState<any>(null);
  const [cart, setCart] = useState<{ mid: number; name: string; batch: string; price: number; qty: number }[]>([]);
  const [customer, setCustomer] = useState("");
  const [dash, setDash] = useState<any>(null);
  const [imp, setImp] = useState<{ open: boolean; file: File | null; busy: boolean; res: any }>({ open: false, file: null, busy: false, res: null });
  const [mail, setMail] = useState({ email: "", pw: "", code: "" });
  const [store, setStore] = useState<any>(null);
  const [folderName, setFolderName] = useState("Pharmacy Manager Data");
  const [roleSel, setRoleSel] = useState<Record<number, string>>({});
  const can = (r: string) => !!me && RANK[me.role] >= RANK[r];
  const say = (t: string, k = "ok") => setMsg({ t, k });
  const load = async () => {
    try {
      setMeds(await api("/medicines")); const sl: Row[] = await api("/sales"); setSales(sl); setBills(await api("/bills"));
      const n = new Date(), top: Record<string, number> = {};
      if (can("manager")) {
        const r = await api(`/reports/detail?start=${ld(new Date(n.getTime() - 13 * 864e5))}&end=${ld(n)}&group=day&tz=${-n.getTimezoneOffset()}`);
        r.sales.forEach((x: Row) => { top[x.medicine] = (top[x.medicine] || 0) + x.qty; });
        setDash(mkDash(r.periods.map((p: Row) => ({ d: p.period, sales: p.sales, profit: p.profit })), top));
      } else {
        const by: Record<string, number> = {};
        sl.forEach((x) => { const d = ld(new Date(x.at + "Z")); by[d] = (by[d] || 0) + x.total; top[x.medicine] = (top[x.medicine] || 0) + x.qty; });
        setDash(mkDash(Object.entries(by).map(([d, sales]) => ({ d, sales })), top));
      }
      if (can("manager")) setPurch(await api("/purchases"));
      if (can("admin")) setUsers(await api("/users"));
    } catch (e: any) { say(e.message, "err"); }
  };
  useEffect(() => { api("/me").then(setMe).catch(() => {}); }, []);
  useEffect(() => { if (me) load(); }, [me]);
  useEffect(() => { if (!msg.t) return; const id = setTimeout(() => setMsg({ t: "", k: "ok" }), msg.k === "err" ? 15000 : 4500); return () => clearTimeout(id); }, [msg]);
  const act = async (fn: () => Promise<any>, ok = "Done") => {
    try { const r = await fn(); say(r?.total !== undefined ? `Sale recorded. Total: ${rs(r.total)}` : ok); await load(); return true; }
    catch (e: any) { say(e.message, "err"); return false; }
  };
  const rqs = () => `start=${rq.from}&end=${rq.to}&group=${rq.group}&tz=${-new Date().getTimezoneOffset()}`;
  const runReport = async () => {
    if (!rq.from || !rq.to) return;
    try { setRep(await api("/reports/detail?" + rqs())); } catch (e: any) { say(e.message, "err"); setRep(null); }
  };
  useEffect(() => { if (me && tab === "reports") runReport(); }, [me, tab, rq.from, rq.to, rq.group]);
  const setRange = (r: string) => {
    const n = new Date(); let f = ld(n);
    if (r === "7d") f = ld(new Date(n.getTime() - 6 * 864e5));
    if (r === "month") f = ld(n).slice(0, 8) + "01";
    setRq(r === "custom" ? { ...rq, range: r } : { ...rq, range: r, from: f, to: ld(n) });
  };
  const saveReport = async () => {
    try { const r = await api("/reports/save?" + rqs(), "POST"); say(`Saved ${r.file} on the server disk${r.drive ? " and Google Drive" : ""}`); }
    catch (e: any) { say(e.message, "err"); }
  };
  const cell = (v: any) => { let t = String(v ?? ""); if (typeof v === "string" && /^[=+\-@]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const downloadCsv = () => {
    if (!rep) return; const s = rep.summary;
    const L: any[][] = [["Pharmacy report", rep.start, "to", rep.end, "grouped by " + rep.group], [], ["SUMMARY"], ["Sales", s.sales], ["Cost of goods", s.cogs], ["Profit", s.profit], ["Purchases", s.purchases], ["Transactions", s.count], [],
      ["PERIODS"], ["Period", "Sales count", "Sales", "Cost of goods", "Purchases", "Profit"], ...rep.periods.map((p: Row) => [p.period, p.count, p.sales, p.cogs, p.purchases, p.profit]), [],
      ["SALES"], ["Time", "Medicine", "Qty", "Amount", "Cost", "Profit"], ...rep.sales.map((x: Row) => [x.time, x.medicine, x.qty, x.total, x.cost, x.profit]), [],
      ["PURCHASES"], ["Time", "Medicine", "Qty", "Amount", "Supplier"], ...rep.purchases.map((x: Row) => [x.time, x.medicine, x.qty, x.total, x.supplier])];
    const blob = new Blob(["\ufeff" + L.map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pharmacy-report-${rep.start}_to_${rep.end}-${rep.group}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const addCart = () => {
    if (!selSale) return say("Select a medicine first", "err");
    const q = +sale.qty, have = cart.find((c) => c.mid === selSale.id)?.qty ?? 0;
    if (!(q > 0) || q + have > selSale.stock) return say(`Only ${selSale.stock - have} more units of ${selSale.name} available`, "err");
    setCart(have ? cart.map((c) => (c.mid === selSale.id ? { ...c, qty: c.qty + q } : c)) : [...cart, { mid: selSale.id, name: selSale.name, batch: selSale.batch, price: selSale.price, qty: q }]);
    setSale({ mid: "", qty: "1" });
  };
  const makeBill = async () => {
    try {
      const b = await api("/bills", "POST", { customer, items: cart.map((c) => ({ medicine_id: c.mid, qty: c.qty })) });
      setBill(b); setCart([]); setCustomer(""); say(`Bill ${b.number} generated`); await load();
    } catch (e: any) { say(e.message, "err"); }
  };
  const doImport = async () => {
    if (!imp.file) return say("Choose a file first", "err");
    setImp({ ...imp, busy: true });
    try { const r = await upload(imp.file); setImp({ open: true, file: null, busy: false, res: r }); say(`Imported ${r.added} medicines`); await load(); }
    catch (e: any) { setImp({ ...imp, busy: false }); say(e.message, "err"); }
  };
  const template = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["name,batch,expiry,stock,cost,price\nPanadol 500mg,B1001,2027-12-31,100,8,10\n"], { type: "text/csv" }));
    a.download = "medicine-import-template.csv"; a.click(); URL.revokeObjectURL(a.href);
  };
  useEffect(() => { if (me && tab === "storage") api("/storage/status").then(setStore).catch((e) => say(e.message, "err")); }, [me, tab, msg.t]);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("drive");
    if (p) { setTab("storage"); say(p === "connected" ? "Google Drive connected. First backup uploaded." : "Google Drive was not connected: " + (new URLSearchParams(window.location.search).get("why") || p), p === "connected" ? "ok" : "err"); window.history.replaceState({}, "", "/"); }
  }, []);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);
  const status = (m: Med) => m.expiry < today ? "expired" : m.stock < 10 ? "low" : m.expiry < soon ? "expiring" : "ok";
  const BADGE: Record<string, [string, string]> = { expired: ["Expired", "bad"], low: ["Low stock", "warn"], expiring: ["Expiring soon", "warn"], ok: ["In stock", "ok"] };
  const shown = meds.filter((m) => (m.name + m.batch).toLowerCase().includes(q.toLowerCase()) && (flt === "all" || status(m) === flt));
  const sellable = meds.filter((m) => m.stock > 0 && m.expiry >= today);
  const selSale = meds.find((m) => String(m.id) === sale.mid);
  const saleOk = !!selSale && +sale.qty > 0 && +sale.qty <= selSale.stock && selSale.expiry >= today;
  const todaySales = sales.filter((s) => String(s.at).slice(0, 10) === today).reduce((a, s) => a + s.total, 0);
  const openForm = (m?: Med) => { setEditId(m?.id ?? null); setForm(m ? { name: m.name, batch: m.batch, expiry: m.expiry, stock: String(m.stock), cost: String(m.cost ?? 0), price: String(m.price) } : blank); setModal(true); };
  const save = async () => {
    if (!form.name.trim() || !form.expiry) return say("Medicine name and expiry date are required", "err");
    const body = { ...form, stock: +form.stock, cost: +form.cost, price: +form.price };
    if (await act(() => editId ? api(`/medicines/${editId}`, "PATCH", body) : api("/medicines", "POST", body), editId ? "Medicine updated" : "Medicine added")) setModal(false);
  };

  if (!me) return (
    <GoogleOAuthProvider clientId={process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!}>
      <div className="login"><div className="lbox">
        <div style={{ fontSize: 54 }}>💊</div><h1 style={{ margin: "8px 0" }}>Pharmacy Manager</h1>
        <p style={{ color: "#64748b" }}>Sign in with your Gmail account.<br />New accounts need admin approval.</p>
        <div style={{ display: "flex", justifyContent: "center", margin: "22px 0" }}>
          <GoogleLogin onSuccess={(c) => api("/auth/google", "POST", { credential: c.credential }).then(setMe).catch((e) => say(e.message, "err"))} />
        </div>
        {msg.t && <div className="badge bad" style={{ display: "inline-block", whiteSpace: "normal" }}>{msg.t}</div>}
      </div></div>
    </GoogleOAuthProvider>);

  const title = NAV.find((n) => n[0] === tab)?.[2];
  const roleBadge = me.role === "admin" ? "bad" : me.role === "manager" ? "info" : "ok";
  return (
    <div className="app">
      <aside className="side">
        <div className="brand">💊 Pharmacy<small>Management System</small></div>
        {NAV.filter((n) => can(n[3])).map(([k, ic, lb]) => <button key={k} className={"nav" + (tab === k ? " on" : "")} onClick={() => setTab(k)}><span>{ic}</span>{lb}</button>)}
        <div style={{ flex: 1 }} />
        {can("admin") && <button className="nav" onClick={() => act(() => api("/backup", "POST"), "Backup saved to disk (and Google Drive if configured)")}><span>💾</span>Backup now</button>}
      </aside>
      <main className="main">
        <div className="top"><h1>{title}</h1>
          <div className="chip">{me.name || me.email} <span className={"badge " + roleBadge}>{me.role}</span>
            <button className="btn sm" style={{ margin: 0 }} onClick={() => api("/auth/logout", "POST").then(() => setMe(null))}>Logout</button></div></div>

        {tab === "dashboard" && (<>
          <div className="hero"><div><h2>Welcome back, {(me.name || me.email).split(" ")[0]} 👋</h2>
            <p>{new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p></div>
            <div><button className="btn" onClick={() => setTab("sales")}>🧾 New bill</button>{" "}
              {can("manager") && <button className="btn" onClick={() => { setTab("inventory"); openForm(); }}>＋ Add medicine</button>}</div></div>
          <div className="stats">
            <div className="stat"><span>💊 Medicines</span><b>{meds.length}</b></div>
            <div className="stat b"><span>💰 Today&apos;s sales</span><b>{rs(todaySales)}</b></div>
            <div className="stat w"><span>📉 Low stock</span><b>{meds.filter((m) => status(m) === "low").length}</b></div>
            <div className="stat w"><span>⏳ Expiring in 90 days</span><b>{meds.filter((m) => m.expiry >= today && m.expiry < soon).length}</b></div>
            <div className="stat r"><span>⛔ Expired</span><b>{meds.filter((m) => status(m) === "expired").length}</b></div>
            {can("manager") && <div className="stat b"><span>📈 Profit (14 days)</span><b>{rs((dash?.days ?? []).reduce((a: number, d: any) => a + (d.b ?? 0), 0))}</b></div>}
          </div>
          <div className="row2">
            <div className="card"><h3>Sales{can("manager") ? " and profit" : ""} — last 14 days (Rs)</h3>{dash && <Bars data={dash.days} />}
              <small style={{ color: "#64748b" }}>■ <span style={{ color: "#0f766e" }}>Sales</span>{can("manager") && <> &nbsp; ■ <span style={{ color: "#f59e0b" }}>Profit</span></>}</small></div>
            <div className="card"><h3>Stock health</h3><Donut parts={[["In stock", meds.filter((m) => status(m) === "ok").length, "#16a34a"], ["Low stock", meds.filter((m) => status(m) === "low").length, "#f59e0b"], ["Expiring soon", meds.filter((m) => status(m) === "expiring").length, "#fb923c"], ["Expired", meds.filter((m) => status(m) === "expired").length, "#dc2626"]]} /></div>
          </div>
          <div className="row2">
            <div className="card"><h3>🏆 Top selling medicines (14 days)</h3>
              {dash?.top.length ? dash.top.map(([n, q]: [string, number]) => <div className="hb" key={n}>{n} <b>({q} sold)</b><div><i style={{ width: (q / dash.top[0][1]) * 100 + "%" }} /></div></div>) : <div className="empty">No sales yet.</div>}</div>
            <div className="card"><h3>⚠️ Needs attention</h3>
              <Table rows={meds.filter((m) => status(m) === "expired" || status(m) === "low").slice(0, 8)} cols={[["Medicine", (m) => m.name], ["Stock", (m) => m.stock], ["Status", (m) => <span className={"badge " + BADGE[status(m)][1]}>{BADGE[status(m)][0]}</span>]]} /></div>
          </div></>)}

        {tab === "inventory" && (<div className="card">
          <div className="bar"><div className="grid" style={{ flex: 1, maxWidth: 560 }}>
            <Field label="Search"><input placeholder="Medicine name or batch no." value={q} onChange={(e) => setQ(e.target.value)} /></Field>
            <Field label="Filter by status"><select value={flt} onChange={(e) => setFlt(e.target.value)}>
              <option value="all">All medicines</option><option value="low">Low stock</option><option value="expiring">Expiring soon</option><option value="expired">Expired</option></select></Field></div>
            {can("manager") && <div><button className="btn" onClick={() => setImp({ open: true, file: null, busy: false, res: null })}>⬆ Import Excel/CSV</button>{" "}<button className="btn primary" onClick={() => openForm()}>＋ Add medicine</button></div>}</div>
          <Table rows={shown} cols={[["Medicine", (m) => <b>{m.name}</b>], ["Batch", (m) => m.batch], ["Expiry", (m) => m.expiry], ["Stock", (m) => m.stock],
            ...(can("manager") ? [["Cost", (m: Row) => rs(m.cost)] as [string, (r: Row) => React.ReactNode]] : []), ["Price", (m) => rs(m.price)],
            ["Status", (m) => <span className={"badge " + BADGE[status(m as Med)][1]}>{BADGE[status(m as Med)][0]}</span>],
            ["Actions", (m) => (<>
              {can("manager") && <button className="btn sm warn" onClick={() => openForm(m as Med)}>Edit</button>}
              {can("admin") && <button className="btn sm danger" onClick={() => confirm(`Delete ${m.name}? This cannot be undone.`) && act(() => api(`/medicines/${m.id}`, "DELETE"), "Medicine deleted")}>Delete</button>}</>)]]} />
        </div>)}

        {tab === "sales" && (<>
          <div className="card"><h3>Create bill</h3><div className="grid">
            <Field label="Customer name (optional)"><input value={customer} maxLength={80} onChange={(e) => setCustomer(e.target.value)} /></Field>
            <Field label="Medicine"><select value={sale.mid} onChange={(e) => setSale({ ...sale, mid: e.target.value })}>
              <option value="">— Select medicine —</option>{sellable.map((m) => <option key={m.id} value={m.id}>{m.name} · batch {m.batch} · {m.stock} in stock · {rs(m.price)}</option>)}</select></Field>
            <Field label="Quantity"><input type="number" min={1} value={sale.qty} onChange={(e) => setSale({ ...sale, qty: e.target.value })} /></Field>
            <button className="btn primary" onClick={addCart}>＋ Add to bill</button></div>
            {cart.length > 0 && (<div style={{ marginTop: 18 }}>
              <Table rows={cart.map((c) => ({ ...c, id: c.mid }))} cols={[["Medicine", (c) => c.name], ["Batch", (c) => c.batch], ["Qty", (c) => c.qty], ["Price", (c) => rs(c.price)], ["Amount", (c) => rs(c.price * c.qty)],
                ["", (c) => <button className="btn sm danger" onClick={() => setCart(cart.filter((x) => x.mid !== c.mid))}>Remove</button>]]} />
              <div style={{ textAlign: "right", marginTop: 14, fontSize: 20 }}>Bill total: <b>{rs(cart.reduce((a, c) => a + c.price * c.qty, 0))}</b>{" "}
                <button className="btn primary" onClick={makeBill}>🧾 Generate bill</button></div></div>)}</div>
          <div className="card"><h3>{can("manager") ? "All bills" : "My bills"}</h3>
            <Table rows={bills} cols={[["Bill no.", (b) => <b>{b.number}</b>], ["Customer", (b) => b.customer || "Walk-in"], ["Total", (b) => rs(b.total)], ["Cashier", (b) => b.by], ["Date", (b) => new Date(b.at + "Z").toLocaleString()],
              ["", (b) => <button className="btn sm" onClick={() => api(`/bills/${b.id}`).then(setBill).catch((e) => say(e.message, "err"))}>View / Print</button>]]} /></div></>)}

        {tab === "purchases" && can("manager") && (<>
          <div className="card"><h3>Record purchase / restock</h3><div className="grid">
            <Field label="Medicine"><select value={pur.mid} onChange={(e) => setPur({ ...pur, mid: e.target.value })}>
              <option value="">— Select medicine —</option>{meds.map((m) => <option key={m.id} value={m.id}>{m.name} · batch {m.batch}</option>)}</select></Field>
            <Field label="Quantity received"><input type="number" min={1} value={pur.qty} onChange={(e) => setPur({ ...pur, qty: e.target.value })} /></Field>
            <Field label="Supplier name"><input value={pur.supplier} onChange={(e) => setPur({ ...pur, supplier: e.target.value })} /></Field>
            <button className="btn primary" disabled={!pur.mid || +pur.qty < 1} onClick={async () => { if (await act(() => api("/purchases", "POST", { medicine_id: +pur.mid, qty: +pur.qty, supplier: pur.supplier }), "Stock updated")) setPur({ mid: "", qty: "1", supplier: "" }); }}>Add to stock</button>
          </div></div>
          <div className="card"><h3>Purchase history</h3>
            <Table rows={purch} cols={[["#", (r) => r.id], ["Medicine", (r) => r.medicine], ["Qty", (r) => r.qty], ["Total cost", (r) => rs(r.total)], ["Supplier", (r) => r.supplier || "—"], ["Date", (r) => new Date(r.at + "Z").toLocaleString()]]} /></div></>)}

        {tab === "reports" && can("manager") && (<>
          <div className="card noprint"><h3>Report filters</h3><div className="grid">
            <Field label="Period"><select value={rq.range} onChange={(e) => setRange(e.target.value)}>
              <option value="today">Today</option><option value="7d">Last 7 days</option><option value="month">This month</option><option value="custom">Custom range</option></select></Field>
            <Field label="From date"><input type="date" value={rq.from} onChange={(e) => setRq({ ...rq, range: "custom", from: e.target.value })} /></Field>
            <Field label="To date"><input type="date" value={rq.to} onChange={(e) => setRq({ ...rq, range: "custom", to: e.target.value })} /></Field>
            <Field label="Group by"><select value={rq.group} onChange={(e) => setRq({ ...rq, group: e.target.value })}>
              <option value="hour">Hour-wise</option><option value="day">Day-wise</option><option value="month">Month-wise</option></select></Field>
          </div><div style={{ marginTop: 16 }}>
            <button className="btn primary" disabled={!rep} onClick={downloadCsv}>⬇ Download CSV</button>{" "}
            <button className="btn" disabled={!rep} onClick={() => window.print()}>🖨 Print / Save as PDF</button>{" "}
            <button className="btn warn" disabled={!rep} onClick={saveReport}>💾 Save on server (disk + Drive)</button></div></div>
          {rep && (<>
            <p style={{ color: "#64748b" }}>Report from <b>{rep.start}</b> to <b>{rep.end}</b>, {rep.group}-wise. Profit = sales minus cost of the medicines sold.</p>
            <div className="stats">
              <div className="stat b"><span>Total sales</span><b>{rs(rep.summary.sales)}</b></div>
              <div className="stat w"><span>Cost of goods sold</span><b>{rs(rep.summary.cogs)}</b></div>
              <div className={"stat" + (rep.summary.profit < 0 ? " r" : "")}><span>Profit</span><b>{rs(rep.summary.profit)}</b></div>
              <div className="stat"><span>Margin</span><b>{rep.summary.sales ? ((rep.summary.profit / rep.summary.sales) * 100).toFixed(1) : "0.0"}%</b></div>
              <div className="stat w"><span>Purchases (stock bought)</span><b>{rs(rep.summary.purchases)}</b></div>
              <div className="stat"><span>Sales made</span><b>{rep.summary.count}</b></div>
            </div>
            <div className="card"><h3>{rep.group === "hour" ? "Hour-wise" : rep.group === "day" ? "Day-wise" : "Month-wise"} summary</h3>
              <Table rows={rep.periods.map((p: Row) => ({ ...p, id: p.period }))} cols={[["Period", (p) => p.period], ["Sales made", (p) => p.count], ["Sales", (p) => rs(p.sales)], ["Cost of goods", (p) => rs(p.cogs)], ["Purchases", (p) => rs(p.purchases)], ["Profit", (p) => <b style={{ color: p.profit < 0 ? "#b91c1c" : "#166534" }}>{rs(p.profit)}</b>]]} /></div>
            <div className="card"><h3>Sales detail</h3>
              <Table rows={rep.sales.map((x: Row, i: number) => ({ ...x, id: i }))} cols={[["Date & time", (x) => x.time], ["Medicine", (x) => x.medicine], ["Qty", (x) => x.qty], ["Amount", (x) => rs(x.total)], ["Cost", (x) => rs(x.cost)], ["Profit", (x) => rs(x.profit)]]} /></div>
            <div className="card"><h3>Purchase detail</h3>
              <Table rows={rep.purchases.map((x: Row, i: number) => ({ ...x, id: i }))} cols={[["Date & time", (x) => x.time], ["Medicine", (x) => x.medicine], ["Qty", (x) => x.qty], ["Amount", (x) => rs(x.total)], ["Supplier", (x) => x.supplier || "—"]]} /></div></>)}
        </>)}

        {tab === "storage" && can("admin") && store && (<>
          <div className="card"><h3>🖥️ This computer (hard drive)</h3>
            <p>Every change (stock, sales, bills, purchases, users) is saved automatically as a full snapshot.</p>
            <div className="sum">Folder: <b style={{ wordBreak: "break-all" }}>{store.local_dir}</b><br />Snapshots kept: <b>{store.local_count}</b> (latest 200) · Last saved: <b>{store.local_last ? new Date(store.local_last * 1000).toLocaleString() : "never"}</b><br />
              Excel-readable copies (medicines, sales, purchases, bills) are in the <b>latest</b> subfolder, and saved reports in <b>reports</b>.</div></div>
          <div className="card"><h3>📧 Gmail backup (email)</h3>
            {store.mail_verified ? (<>
              <p><span className="badge ok">Verified</span> Backups are emailed to <b>{store.mail_email}</b></p>
              <p>Last email sent: <b>{store.mail_last_ok ? new Date(store.mail_last_ok + "Z").toLocaleString() : "not yet"}</b>{store.mail_error && <> · <span className="badge bad">Error: {store.mail_error}</span></>}</p>
              <div className="grid" style={{ maxWidth: 480 }}><Field label="Automatic backup email">
                <select value={store.mail_freq} onChange={(e) => act(() => api("/mail/settings", "POST", { frequency: e.target.value }), "Setting saved")}>
                  <option value="daily">Daily (sent with the first change of each day)</option><option value="off">Off (manual only)</option></select></Field></div>
              <p style={{ color: "#64748b", fontSize: 14 }}>Each email attaches the full data (JSON) and Excel-readable files for medicines, sales, purchases and bills. Keep this mailbox private.</p>
              <button className="btn primary" onClick={() => act(() => api("/backup", "POST"), "Backup email is on its way")}>📨 Send backup email now</button>{" "}
              <button className="btn danger" onClick={() => confirm("Remove this Gmail from backups?") && act(() => api("/mail/disconnect", "POST"), "Gmail removed")}>Remove Gmail</button></>
            ) : store.mail_pending ? (<>
              <p>We sent a 6-digit code to <b>{store.mail_pending}</b>. Open that mailbox and enter the code (valid for 10 minutes).</p>
              <div className="grid" style={{ maxWidth: 440 }}><Field label="Verification code"><input inputMode="numeric" maxLength={6} value={mail.code} onChange={(e) => setMail({ ...mail, code: e.target.value.replace(/[^0-9]/g, "") })} /></Field>
                <button className="btn primary" disabled={mail.code.length !== 6} onClick={async () => { if (await act(() => api("/mail/verify", "POST", { code: mail.code }), "Gmail verified. Backups will now be emailed.")) setMail({ email: "", pw: "", code: "" }); }}>Verify</button></div>
              <p><button className="btn sm" onClick={() => act(() => api("/mail/disconnect", "POST"), "Cancelled")}>Use a different Gmail</button></p></>
            ) : (<>
              <div className="sum" style={{ marginBottom: 14, lineHeight: 1.7 }}><b>How to get a Gmail App Password (1 minute):</b><br />1. Open your Google Account → Security → turn on <b>2-Step Verification</b>.<br />
                2. Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>, create one named &quot;Pharmacy&quot; and copy the 16 characters.<br />3. Enter them below. We email a code to verify it is your mailbox.</div>
              <div className="grid" style={{ maxWidth: 700 }}>
                <Field label="Gmail address"><input type="email" placeholder="yourname@gmail.com" value={mail.email} onChange={(e) => setMail({ ...mail, email: e.target.value })} /></Field>
                <Field label="Gmail App Password"><input type="password" autoComplete="off" placeholder="16-character app password" value={mail.pw} onChange={(e) => setMail({ ...mail, pw: e.target.value })} /></Field>
                <button className="btn primary" disabled={!mail.email || mail.pw.length < 8} onClick={async () => { if (await act(() => api("/mail/send-code", "POST", { email: mail.email, app_password: mail.pw }), "Verification code sent. Check your Gmail inbox.")) setMail({ email: "", pw: "", code: "" }); }}>Send verification code</button></div></>)}
          </div>
          <div className="card"><h3>☁️ Google Drive (optional)</h3>
            {!store.drive_ready ? (<div className="sum" style={{ borderColor: "#f59e0b" }}>Google Drive is not set up yet. In <b>backend/.env</b> set <b>GOOGLE_CLIENT_SECRET</b> (from your Google OAuth client) and add this under <i>Authorized redirect URIs</i> in Google Cloud: <b>{store.redirect_uri}</b>. Then restart the backend.</div>
            ) : store.drive_connected ? (<>
              <p><span className="badge ok">Connected</span> Folder: <b>{store.drive_folder}</b></p>
              <p>Last upload: <b>{store.drive_last_ok ? new Date(store.drive_last_ok + "Z").toLocaleString() : "pending"}</b>{store.drive_error && <> · <span className="badge bad">Last error: {store.drive_error}</span></>}</p>
              <p style={{ color: "#64748b", fontSize: 14 }}>Files kept in that folder: pharmacy-latest.json (updated on every change) and one pharmacy-DATE.json per day. &quot;Backup now&quot; also uploads the CSV files.</p>
              <button className="btn primary" onClick={() => act(() => api("/backup", "POST"), "Backup started")}>💾 Backup now</button>{" "}
              <button className="btn danger" onClick={() => confirm("Disconnect Google Drive? Files already in Drive stay there.") && act(() => api("/drive/disconnect", "POST"), "Google Drive disconnected")}>Disconnect</button></>
            ) : (<div className="grid" style={{ maxWidth: 640 }}>
              <Field label="Folder name to create in Drive"><input value={folderName} maxLength={80} onChange={(e) => setFolderName(e.target.value)} /></Field>
              <button className="btn primary" onClick={() => api("/drive/connect?folder=" + encodeURIComponent(folderName)).then((r) => { window.location.href = r.url; }).catch((e) => say(e.message, "err"))}>Connect Google Drive</button>
              <p style={{ gridColumn: "1/-1", color: "#64748b", fontSize: 14, margin: 0 }}>You will choose which Google account to use. The app can only access the folder and files it creates, not the rest of that Drive.</p></div>)}
          </div></>)}

        {tab === "users" && can("admin") && (<>
          <div className="card"><h3>Pending / inactive accounts ({users.filter((u) => !u.active).length})</h3>
            <Table rows={users.filter((u) => !u.active)} cols={[["Email", (u) => u.email],
              ["Assign role", (u) => <select value={roleSel[u.id] || "salesperson"} onChange={(e) => setRoleSel({ ...roleSel, [u.id]: e.target.value })}><option value="salesperson">Salesperson</option><option value="manager">Manager</option><option value="admin">Admin</option></select>],
              ["Decision", (u) => (<>
                <button className="btn sm primary" onClick={() => act(() => api(`/users/${u.id}`, "PATCH", { role: roleSel[u.id] || "salesperson", active: true }), `${u.email} approved`)}>Approve</button>
                <button className="btn sm danger" onClick={() => confirm(`Reject and remove ${u.email}?`) && act(() => api(`/users/${u.id}`, "DELETE"), `${u.email} rejected`)}>Reject</button></>)]]} /></div>
          <div className="card"><h3>Active users</h3>
            <Table rows={users.filter((u) => u.active)} cols={[["Email", (u) => <>{u.email}{u.email === me.email && " (you)"}</>],
              ["Role", (u) => u.email === me.email ? <span className="badge bad">{u.role}</span> :
                <select value={u.role} onChange={(e) => act(() => api(`/users/${u.id}`, "PATCH", { role: e.target.value }), "Role updated")}><option value="salesperson">Salesperson</option><option value="manager">Manager</option><option value="admin">Admin</option></select>],
              ["Access", (u) => u.email === me.email ? "—" : <button className="btn sm warn" onClick={() => confirm(`Disable ${u.email}? They will be signed out.`) && act(() => api(`/users/${u.id}`, "PATCH", { active: false }), `${u.email} disabled`)}>Disable</button>]]} /></div></>)}
      </main>

      {modal && (<div className="ov" onClick={() => setModal(false)}><div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{editId ? "Edit medicine" : "Add new medicine"}</h3>
        <div className="grid">
          <Field label="Medicine name *"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Batch number"><input value={form.batch} onChange={(e) => setForm({ ...form, batch: e.target.value })} /></Field>
          <Field label="Expiry date *"><input type="date" value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></Field>
          <Field label="Stock quantity"><input type="number" min={0} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></Field>
          <Field label="Cost price (Rs)"><input type="number" min={0} step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
          <Field label="Selling price (Rs)"><input type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></Field>
        </div>
        <div style={{ marginTop: 20, textAlign: "right" }}><button className="btn" onClick={() => setModal(false)}>Cancel</button>{" "}<button className="btn primary" onClick={save}>{editId ? "Save changes" : "Add medicine"}</button></div>
      </div></div>)}
            {bill && (<div className="ov" onClick={() => setBill(null)}><div className="modal bill" onClick={(e) => e.stopPropagation()}>
        <div style={{ textAlign: "center" }}><h2 style={{ margin: 0 }}>💊 {PH}</h2><div style={{ color: "#64748b" }}>Sales Invoice</div></div>
        <div style={{ display: "flex", justifyContent: "space-between", margin: "16px 0", fontSize: 14 }}>
          <div>Bill no: <b>{bill.number}</b><br />Customer: {bill.customer || "Walk-in"}</div>
          <div style={{ textAlign: "right" }}>{new Date(bill.at + "Z").toLocaleString()}<br />Cashier: {bill.by}</div></div>
        <Table rows={bill.lines.map((l: Row, i: number) => ({ ...l, id: i }))} cols={[["Medicine", (l) => l.medicine], ["Batch", (l) => l.batch], ["Qty", (l) => l.qty], ["Price", (l) => rs(l.price)], ["Amount", (l) => rs(l.total)]]} />
        <div style={{ textAlign: "right", fontSize: 22, margin: "16px 0" }}>Total: <b>{rs(bill.total)}</b></div>
        <p style={{ textAlign: "center", color: "#64748b", fontSize: 13 }}>Thank you. Please check medicines and expiry dates before leaving the counter.</p>
        <div className="noprint" style={{ textAlign: "right" }}><button className="btn" onClick={() => setBill(null)}>Close</button>{" "}<button className="btn primary" onClick={() => window.print()}>🖨 Print bill</button></div>
      </div></div>)}
      {imp.open && (<div className="ov" onClick={() => !imp.busy && setImp({ ...imp, open: false })}><div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Import medicines from Excel / CSV</h3>
        <p style={{ fontSize: 14, color: "#475569" }}>The first row must contain these column names: <b>name, batch, expiry, stock, cost, price</b>. Expiry format: YYYY-MM-DD or DD/MM/YYYY. Medicines that already exist (same name and batch) are skipped.</p>
        <button className="btn sm" onClick={template}>⬇ Download CSV template</button>
        <div className="drop" style={{ margin: "14px 0" }}><input type="file" accept=".csv,.xlsx" onChange={(e) => setImp({ ...imp, file: e.target.files?.[0] ?? null, res: null })} /></div>
        {imp.res && (<div className="sum"><b>{imp.res.added} added</b>, {imp.res.skipped} skipped{imp.res.errors.length > 0 && <ul style={{ maxHeight: 140, overflow: "auto", margin: "8px 0 0", paddingLeft: 18 }}>{imp.res.errors.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}</div>)}
        <div style={{ marginTop: 18, textAlign: "right" }}><button className="btn" disabled={imp.busy} onClick={() => setImp({ ...imp, open: false })}>Close</button>{" "}
          <button className="btn primary" disabled={!imp.file || imp.busy} onClick={doImport}>{imp.busy ? "Importing…" : "Import file"}</button></div>
      </div></div>)}
      {msg.t && <div className={"toast " + msg.k} onClick={() => setMsg({ t: "", k: "ok" })}>{msg.t}</div>}
    </div>);
}
