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
