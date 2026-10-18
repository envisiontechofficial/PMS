import os, json, csv, re, hmac, secrets, smtplib, threading, hashlib, base64, datetime as dt
from email.message import EmailMessage
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, Depends, HTTPException, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from google.oauth2 import id_token
from google.auth.transport import requests as grequests
from jose import jwt, JWTError

load_dotenv()
CID = os.environ["GOOGLE_CLIENT_ID"]; SECRET = os.environ["JWT_SECRET"]
ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")
BACKUP = Path(os.getenv("LOCAL_BACKUP_DIR", "./backups")); BACKUP.mkdir(exist_ok=True)
SECURE = os.getenv("COOKIE_SECURE", "false") == "true"
CSEC = os.getenv("GOOGLE_CLIENT_SECRET", ""); REDIRECT = os.getenv("BACKEND_URL", "http://localhost:8000") + "/drive/callback"
DSCOPE = "https://www.googleapis.com/auth/drive.file"
ROLES = {"admin": 3, "manager": 2, "salesperson": 1}

engine = create_engine("sqlite:///pharmacy.db", connect_args={"check_same_thread": False})
Session_ = sessionmaker(bind=engine); Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True); email = Column(String, unique=True, index=True)
    name = Column(String); role = Column(String, default="salesperson"); active = Column(Boolean, default=True)
class Medicine(Base):
    __tablename__ = "medicines"
    id = Column(Integer, primary_key=True); name = Column(String, index=True); batch = Column(String)
    expiry = Column(String); stock = Column(Integer, default=0); cost = Column(Float); price = Column(Float)
class Sale(Base):
    __tablename__ = "sales"
    id = Column(Integer, primary_key=True); medicine_id = Column(Integer, ForeignKey("medicines.id"))
    qty = Column(Integer); total = Column(Float); user_id = Column(Integer, ForeignKey("users.id")); cost_total = Column(Float); bill_id = Column(Integer)
    at = Column(DateTime, default=dt.datetime.utcnow)
class Purchase(Base):
    __tablename__ = "purchases"
    id = Column(Integer, primary_key=True); medicine_id = Column(Integer, ForeignKey("medicines.id"))
    qty = Column(Integer); total = Column(Float); supplier = Column(String); user_id = Column(Integer)
    at = Column(DateTime, default=dt.datetime.utcnow)
class Audit(Base):
    __tablename__ = "audit"
    id = Column(Integer, primary_key=True); who = Column(String); action = Column(String)
    at = Column(DateTime, default=dt.datetime.utcnow)
class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True); value = Column(String)
class Bill(Base):
    __tablename__ = "bills"
    id = Column(Integer, primary_key=True); customer = Column(String); total = Column(Float)
    user_id = Column(Integer, ForeignKey("users.id")); at = Column(DateTime, default=dt.datetime.utcnow)
Base.metadata.create_all(engine)
for _ddl in ("ALTER TABLE sales ADD COLUMN cost_total FLOAT", "ALTER TABLE sales ADD COLUMN bill_id INTEGER"):
    try:
        with engine.begin() as _c: _c.exec_driver_sql(_ddl)  # upgrade older databases
    except Exception: pass

app = FastAPI(title="Pharmacy API", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[ORIGIN], allow_credentials=True,
                   allow_methods=["GET", "POST", "PATCH", "DELETE"], allow_headers=["Content-Type", "X-CSRF"])

def db():
    s = Session_()
    try: yield s
    finally: s.close()

def current(role: str):
    def dep(request: Request, s: Session = Depends(db)) -> User:
        if request.method != "GET" and request.headers.get("X-CSRF") != "1":
            raise HTTPException(403, "CSRF check failed")
        try: uid = jwt.decode(request.cookies.get("session", ""), SECRET, algorithms=["HS256"])["sub"]
        except JWTError: raise HTTPException(401, "Not signed in")
        u = s.get(User, int(uid))
        if not u or not u.active: raise HTTPException(401, "Account disabled")
        if ROLES[u.role] < ROLES[role]: raise HTTPException(403, "Insufficient role")
        return u
    return dep

def log(s: Session, who: str, action: str):
    s.add(Audit(who=who, action=action)); s.commit(); snapshot(s)

def snapshot(s: Session, manual: bool = False):
    """Save ALL records to the hard drive (every change) and to the admin's Google Drive if connected."""
    tabs = {"users": User, "medicines": Medicine, "sales": Sale, "purchases": Purchase, "bills": Bill, "audit": Audit}
    data = {k: [{c.name: str(getattr(r, c.name)) for c in m.__table__.columns} for r in s.query(m).all()] for k, m in tabs.items()}
    now = dt.datetime.utcnow(); BACKUP.mkdir(exist_ok=True); text = json.dumps(data, indent=1)
    (BACKUP / f"pharmacy-{now:%Y%m%d-%H%M%S}.json").write_text(text)
    for old in sorted(BACKUP.glob("pharmacy-2*.json"))[:-200]: old.unlink()
    latest = BACKUP / "latest"; latest.mkdir(exist_ok=True); (latest / "pharmacy-latest.json").write_text(text)
    for k in ("medicines", "sales", "purchases", "bills"):
        cols = [c.name for c in tabs[k].__table__.columns]
        with open(latest / f"{k}.csv", "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f); w.writerow(cols)
            for r in data[k]: w.writerow([_safe(r[c]) for c in cols])
    ref, fid = sget(s, "drive_token"), sget(s, "drive_folder_id")
    if ref and fid:
        files = [(latest / "pharmacy-latest.json", "pharmacy-latest.json"), (latest / "pharmacy-latest.json", f"pharmacy-{now:%Y-%m-%d}.json")]
        if manual: files += [(latest / f"{k}.csv", f"{k}.csv") for k in ("medicines", "sales", "purchases", "bills")]
        threading.Thread(target=_drive_job, args=(files, _dec(ref), fid), daemon=True).start()
    try:
        if sget(s, "mail_verified") == "1":
            day = f"{now:%Y-%m-%d}"
            if manual or (sget(s, "mail_freq") == "daily" and sget(s, "mail_last_date") != day):
                sset(s, "mail_last_date", day)
                mf = [(latest / n, n) for n in ("pharmacy-latest.json", "medicines.csv", "sales.csv", "purchases.csv", "bills.csv")]
                threading.Thread(target=_mail_job, args=(sget(s, "mail_email"), _dec(sget(s, "mail_pw")), mf), daemon=True).start()
    except Exception as e: print("Mail backup skipped:", e)

class GoogleLogin(BaseModel): credential: str
@app.post("/auth/google")
def login(b: GoogleLogin, res: Response, s: Session = Depends(db)):
    try: info = id_token.verify_oauth2_token(b.credential, grequests.Request(), CID)
    except ValueError: raise HTTPException(401, "Invalid Google token")
    if not info.get("email_verified"): raise HTTPException(401, "Email not verified")
    u = s.query(User).filter_by(email=info["email"].lower()).first()
    if not u:
        first = s.query(User).count() == 0 or info["email"].lower() == os.getenv("FIRST_ADMIN_EMAIL", "").lower()
        u = User(email=info["email"].lower(), name=info.get("name", ""), role="admin" if first else "salesperson", active=first)
        s.add(u); s.commit()
    if not u.active: raise HTTPException(403, "Registered. Waiting for admin approval.")
    tok = jwt.encode({"sub": str(u.id), "exp": dt.datetime.utcnow() + dt.timedelta(hours=8)}, SECRET)
    res.set_cookie("session", tok, httponly=True, secure=SECURE, samesite="strict", max_age=28800)
    return {"email": u.email, "name": u.name, "role": u.role}

@app.post("/auth/logout")
def logout(res: Response): res.delete_cookie("session"); return {"ok": True}
@app.get("/me")
def me(u: User = Depends(current("salesperson"))): return {"email": u.email, "name": u.name, "role": u.role}

@app.get("/users")
def users(u: User = Depends(current("admin")), s: Session = Depends(db)):
    return [{"id": x.id, "email": x.email, "role": x.role, "active": x.active} for x in s.query(User)]
class UserPatch(BaseModel): role: str | None = None; active: bool | None = None
@app.patch("/users/{uid}")
def patch_user(uid: int, b: UserPatch, a: User = Depends(current("admin")), s: Session = Depends(db)):
    t = s.get(User, uid)
    if not t: raise HTTPException(404)
    if t.id == a.id: raise HTTPException(400, "Cannot change your own access")
    if b.role:
        if b.role not in ROLES: raise HTTPException(400, "Bad role")
        t.role = b.role
    if b.active is not None: t.active = b.active
    s.commit(); log(s, a.email, f"user {t.email} -> {b.role},{b.active}"); return {"ok": True}

class MedIn(BaseModel):
    name: str = Field(min_length=1, max_length=120); batch: str; expiry: str
    stock: int = Field(ge=0); cost: float = Field(ge=0); price: float = Field(ge=0)
@app.get("/medicines")
def meds(u: User = Depends(current("salesperson")), s: Session = Depends(db)):
    return [{c.name: getattr(m, c.name) for c in Medicine.__table__.columns if u.role != "salesperson" or c.name != "cost"}
            for m in s.query(Medicine).order_by(Medicine.name)]
@app.post("/medicines")
def add_med(b: MedIn, u: User = Depends(current("manager")), s: Session = Depends(db)):
    m = Medicine(**b.model_dump()); s.add(m); s.commit(); log(s, u.email, f"add medicine {m.name}"); return {"id": m.id}

class Line(BaseModel): medicine_id: int; qty: int = Field(gt=0, le=10000); supplier: str = ""
@app.post("/sales")
def sell(b: Line, u: User = Depends(current("salesperson")), s: Session = Depends(db)):
    n = s.query(Medicine).filter(Medicine.id == b.medicine_id, Medicine.stock >= b.qty,
                                 Medicine.expiry >= dt.date.today().isoformat()).update({Medicine.stock: Medicine.stock - b.qty})
    if not n: s.rollback(); raise HTTPException(400, "Insufficient stock or medicine expired")
    m = s.get(Medicine, b.medicine_id); sale = Sale(medicine_id=m.id, qty=b.qty, total=m.price * b.qty, user_id=u.id, cost_total=(m.cost or 0) * b.qty)
    s.add(sale); s.commit(); log(s, u.email, f"sale {m.name} x{b.qty}"); return {"id": sale.id, "total": sale.total}
@app.post("/purchases")
def buy(b: Line, u: User = Depends(current("manager")), s: Session = Depends(db)):
    m = s.get(Medicine, b.medicine_id)
    if not m: raise HTTPException(404)
    m.stock += b.qty; s.add(Purchase(medicine_id=m.id, qty=b.qty, total=m.cost * b.qty, supplier=b.supplier, user_id=u.id))
    s.commit(); log(s, u.email, f"purchase {m.name} x{b.qty}"); return {"ok": True}
@app.get("/reports/summary")
def summary(u: User = Depends(current("manager")), s: Session = Depends(db)):
    return {"sales_total": sum(x.total for x in s.query(Sale)), "purchase_total": sum(x.total for x in s.query(Purchase)),
            "low_stock": [m.name for m in s.query(Medicine).filter(Medicine.stock < 10)]}
@app.post("/backup")
def backup(u: User = Depends(current("admin")), s: Session = Depends(db)): snapshot(s, True); return {"ok": True}

class MedPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120); batch: str | None = None; expiry: str | None = None
    stock: int | None = Field(None, ge=0); cost: float | None = Field(None, ge=0); price: float | None = Field(None, ge=0)
@app.patch("/medicines/{mid}")
def edit_med(mid: int, b: MedPatch, u: User = Depends(current("manager")), s: Session = Depends(db)):
    m = s.get(Medicine, mid)
    if not m: raise HTTPException(404)
    for k, v in b.model_dump(exclude_none=True).items(): setattr(m, k, v)
    s.commit(); log(s, u.email, f"edit medicine {m.name}"); return {"ok": True}
@app.delete("/medicines/{mid}")
def del_med(mid: int, u: User = Depends(current("admin")), s: Session = Depends(db)):
    m = s.get(Medicine, mid)
    if not m: raise HTTPException(404)
    if s.query(Sale).filter_by(medicine_id=mid).count() or s.query(Purchase).filter_by(medicine_id=mid).count():
        raise HTTPException(400, "Has sales/purchase history; set stock to 0 instead")
    s.delete(m); s.commit(); log(s, u.email, f"delete medicine {m.name}"); return {"ok": True}
@app.get("/sales")
def sales(u: User = Depends(current("salesperson")), s: Session = Depends(db)):
    q = s.query(Sale, Medicine.name, User.email).join(Medicine, Medicine.id == Sale.medicine_id).join(User, User.id == Sale.user_id)
    if u.role == "salesperson": q = q.filter(Sale.user_id == u.id)
    return [{"id": a.id, "medicine": n, "qty": a.qty, "total": a.total, "by": e, "at": a.at.isoformat()}
            for a, n, e in q.order_by(Sale.id.desc()).limit(200)]
@app.get("/purchases")
def purchases(u: User = Depends(current("manager")), s: Session = Depends(db)):
    q = s.query(Purchase, Medicine.name).join(Medicine, Medicine.id == Purchase.medicine_id).order_by(Purchase.id.desc()).limit(200)
    return [{"id": a.id, "medicine": n, "qty": a.qty, "total": a.total, "supplier": a.supplier, "at": a.at.isoformat()} for a, n in q]

@app.delete("/users/{uid}")
def reject_user(uid: int, a: User = Depends(current("admin")), s: Session = Depends(db)):
    t = s.get(User, uid)
    if not t: raise HTTPException(404)
    if t.id == a.id: raise HTTPException(400, "Cannot remove yourself")
    if t.active: raise HTTPException(400, "Disable the user first")
    if s.query(Sale).filter_by(user_id=uid).count() or s.query(Purchase).filter_by(user_id=uid).count():
        raise HTTPException(400, "User has sales/purchase records; keep the account disabled instead")
    s.delete(t); s.commit(); log(s, a.email, f"rejected/removed user {t.email}"); return {"ok": True}


def to_drive(path: Path) -> bool:
    s = Session_()
    try: ref, fid = sget(s, "drive_token"), sget(s, "drive_folder_id")
    finally: s.close()
    if ref and fid:
        try: drive_push([(path, path.name)], _dec(ref), fid); return True
        except Exception as e: print("Drive upload failed:", e); return False
    sa, folder = os.getenv("GDRIVE_SERVICE_ACCOUNT_FILE"), os.getenv("GDRIVE_FOLDER_ID")
    if not (sa and folder): return False
    try:
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
        from google.oauth2 import service_account
        cr = service_account.Credentials.from_service_account_file(sa, scopes=["https://www.googleapis.com/auth/drive.file"])
        build("drive", "v3", credentials=cr).files().create(body={"name": path.name, "parents": [folder]},
                                                            media_body=MediaFileUpload(str(path))).execute()
        return True
    except Exception as e: print("Drive upload failed:", e); return False

def build_report(s: Session, start: str, end: str, group: str, tz: int):
    try: a = dt.datetime.fromisoformat(start); b = dt.datetime.fromisoformat(end) + dt.timedelta(days=1)
    except ValueError: raise HTTPException(400, "Bad date")
    if b <= a: raise HTTPException(400, "End date must not be before start date")
    if (b - a).days > 366: raise HTTPException(400, "Range too long (maximum 1 year)")
    if group not in ("hour", "day", "month") or abs(tz) > 840: raise HTTPException(400, "Bad option")
    d = dt.timedelta(minutes=tz); lo, hi = a - d, b - d
    fmt = {"hour": "%Y-%m-%d %H:00", "day": "%Y-%m-%d", "month": "%Y-%m"}[group]
    per: dict = {}
    def P(k): return per.setdefault(k, {"period": k, "count": 0, "sales": 0.0, "cogs": 0.0, "purchases": 0.0, "profit": 0.0})
    srows, prows = [], []
    for sale, m in s.query(Sale, Medicine).join(Medicine, Medicine.id == Sale.medicine_id).filter(Sale.at >= lo, Sale.at < hi).order_by(Sale.at):
        loc = sale.at + d; cogs = sale.cost_total if sale.cost_total is not None else sale.qty * (m.cost or 0)
        p = P(loc.strftime(fmt)); p["count"] += 1; p["sales"] += sale.total; p["cogs"] += cogs
        srows.append({"time": loc.strftime("%Y-%m-%d %H:%M"), "medicine": m.name, "qty": sale.qty, "total": sale.total, "cost": cogs, "profit": sale.total - cogs})
    for pu, name in s.query(Purchase, Medicine.name).join(Medicine, Medicine.id == Purchase.medicine_id).filter(Purchase.at >= lo, Purchase.at < hi).order_by(Purchase.at):
        loc = pu.at + d; P(loc.strftime(fmt))["purchases"] += pu.total
        prows.append({"time": loc.strftime("%Y-%m-%d %H:%M"), "medicine": name, "qty": pu.qty, "total": pu.total, "supplier": pu.supplier or ""})
    rows = sorted(per.values(), key=lambda x: x["period"])
    for p in rows: p["profit"] = p["sales"] - p["cogs"]
    tot = {k: sum(p[k] for p in rows) for k in ("count", "sales", "cogs", "purchases", "profit")}
    r2 = lambda lst: [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in x.items()} for x in lst]
    return {"start": start, "end": end, "group": group, "summary": r2([tot])[0], "periods": r2(rows), "sales": r2(srows), "purchases": r2(prows)}

@app.get("/reports/detail")
def report_detail(start: str, end: str, group: str = "day", tz: int = 0, u: User = Depends(current("manager")), s: Session = Depends(db)):
    return build_report(s, start, end, group, tz)

def _safe(v):
    return "'" + v if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v

@app.post("/reports/save")
def report_save(start: str, end: str, group: str = "day", tz: int = 0, u: User = Depends(current("manager")), s: Session = Depends(db)):
    r = build_report(s, start, end, group, tz); folder = BACKUP / "reports"; folder.mkdir(exist_ok=True)
    path = folder / f"report-{start}_to_{end}-{group}-{dt.datetime.utcnow():%Y%m%d%H%M%S}.csv"
    sm = r["summary"]
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Pharmacy report", start, "to", end, f"grouped by {group}"]); w.writerow([])
        w.writerow(["SUMMARY"]); [w.writerow([k, sm[k]]) for k in ("sales", "cogs", "profit", "purchases", "count")]; w.writerow([])
        w.writerow(["PERIODS"]); w.writerow(["Period", "Sales count", "Sales", "Cost of goods", "Purchases", "Profit"])
        for p in r["periods"]: w.writerow([p["period"], p["count"], p["sales"], p["cogs"], p["purchases"], p["profit"]])
        w.writerow([]); w.writerow(["SALES"]); w.writerow(["Time", "Medicine", "Qty", "Amount", "Cost", "Profit"])
        for x in r["sales"]: w.writerow([x["time"], _safe(x["medicine"]), x["qty"], x["total"], x["cost"], x["profit"]])
        w.writerow([]); w.writerow(["PURCHASES"]); w.writerow(["Time", "Medicine", "Qty", "Amount", "Supplier"])
        for x in r["purchases"]: w.writerow([x["time"], _safe(x["medicine"]), x["qty"], x["total"], _safe(x["supplier"])])
    drive = to_drive(path); log(s, u.email, f"saved report {path.name}")
    return {"file": path.name, "drive": drive}


class Item(BaseModel): medicine_id: int; qty: int = Field(gt=0, le=10000)
class BillIn(BaseModel):
    customer: str = Field("", max_length=80); items: list[Item] = Field(min_length=1, max_length=100)

def bill_view(s: Session, b: Bill):
    by = s.get(User, b.user_id)
    lines = [{"medicine": m.name, "batch": m.batch, "qty": x.qty, "price": m.price, "total": x.total}
             for x, m in s.query(Sale, Medicine).join(Medicine, Medicine.id == Sale.medicine_id).filter(Sale.bill_id == b.id)]
    return {"id": b.id, "number": f"INV-{b.id:06d}", "customer": b.customer or "", "total": round(b.total, 2),
            "at": b.at.isoformat(), "by": by.email if by else "", "lines": lines}

@app.post("/bills")
def make_bill(b: BillIn, u: User = Depends(current("salesperson")), s: Session = Depends(db)):
    qtys: dict = {}
    for i in b.items: qtys[i.medicine_id] = qtys.get(i.medicine_id, 0) + i.qty
    try:
        bill = Bill(customer=b.customer.strip(), total=0.0, user_id=u.id); s.add(bill); s.flush(); total = 0.0
        for mid, q in qtys.items():
            m = s.get(Medicine, mid)
            if not m: raise HTTPException(404, "Medicine not found")
            n = s.query(Medicine).filter(Medicine.id == mid, Medicine.stock >= q, Medicine.expiry >= dt.date.today().isoformat()
                                         ).update({Medicine.stock: Medicine.stock - q})
            if not n: raise HTTPException(400, f"Not enough stock or expired: {m.name}")
            s.add(Sale(medicine_id=mid, qty=q, total=m.price * q, user_id=u.id, cost_total=(m.cost or 0) * q, bill_id=bill.id)); total += m.price * q
        bill.total = total; s.commit()
    except HTTPException: s.rollback(); raise
    log(s, u.email, f"bill INV-{bill.id:06d} total {total}"); return bill_view(s, bill)

@app.get("/bills")
def list_bills(u: User = Depends(current("salesperson")), s: Session = Depends(db)):
    q = s.query(Bill, User.email).join(User, User.id == Bill.user_id)
    if u.role == "salesperson": q = q.filter(Bill.user_id == u.id)
    return [{"id": b.id, "number": f"INV-{b.id:06d}", "customer": b.customer or "", "total": round(b.total, 2), "by": e, "at": b.at.isoformat()}
            for b, e in q.order_by(Bill.id.desc()).limit(100)]

@app.get("/bills/{bid}")
def get_bill(bid: int, u: User = Depends(current("salesperson")), s: Session = Depends(db)):
    b = s.get(Bill, bid)
    if not b or (u.role == "salesperson" and b.user_id != u.id): raise HTTPException(404, "Bill not found")
    return bill_view(s, b)

def _pdate(v):
    if isinstance(v, dt.datetime): return v.date().isoformat()
    if isinstance(v, dt.date): return v.isoformat()
    for f in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try: return dt.datetime.strptime(str(v or "").strip(), f).date().isoformat()
        except ValueError: pass
    raise ValueError("bad expiry date (use YYYY-MM-DD or DD/MM/YYYY)")

@app.post("/medicines/import")
async def import_meds(request: Request, filename: str = "", u: User = Depends(current("manager")), s: Session = Depends(db)):
    import io
    data = await request.body()
    if len(data) > 5_000_000: raise HTTPException(413, "File too large (max 5 MB)")
    name = filename.lower()
    if name.endswith(".csv"): rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig", errors="replace"))))
    elif name.endswith(".xlsx"):
        try: from openpyxl import load_workbook
        except ImportError: raise HTTPException(500, "Excel support missing. Run: pip install openpyxl")
        try: rows = [list(r) for r in load_workbook(io.BytesIO(data), read_only=True, data_only=True).active.iter_rows(values_only=True)]
        except Exception: raise HTTPException(400, "Could not read this Excel file")
    else: raise HTTPException(400, "Please upload a .csv or .xlsx file")
    if not rows: raise HTTPException(400, "File is empty")
    head = [str(h or "").strip().lower() for h in rows[0]]; need = ["name", "batch", "expiry", "stock", "cost", "price"]
    if any(c not in head for c in need): raise HTTPException(400, "Missing columns. Required: name, batch, expiry, stock, cost, price")
    ix = {c: head.index(c) for c in need}
    have = {(m.name.lower(), (m.batch or "").lower()) for m in s.query(Medicine)}
    added = skipped = 0; errs: list = []
    for n, r in enumerate(rows[1:5001], start=2):
        if not any(str(c or "").strip() for c in r): continue
        g = lambda k: r[ix[k]] if ix[k] < len(r) else None
        try:
            nm = str(g("name") or "").strip(); bt = str(g("batch") or "").strip()
            if not nm or len(nm) > 120: raise ValueError("name missing or too long")
            stock = int(float(g("stock") or 0)); cost = float(g("cost") or 0); price = float(g("price") or 0)
            if not (0 <= stock <= 10**7 and 0 <= cost < 1e9 and 0 <= price < 1e9): raise ValueError("invalid number")
            exp = _pdate(g("expiry"))
        except (ValueError, TypeError) as e: errs.append(f"Row {n}: {e}"); continue
        if (nm.lower(), bt.lower()) in have: skipped += 1; errs.append(f"Row {n}: {nm} batch {bt} already exists (skipped)"); continue
        have.add((nm.lower(), bt.lower())); s.add(Medicine(name=nm, batch=bt, expiry=exp, stock=stock, cost=cost, price=price)); added += 1
    s.commit(); log(s, u.email, f"imported {added} medicines from {filename}")
    return {"added": added, "skipped": skipped, "errors": errs[:50]}

def _fernet():
    from cryptography.fernet import Fernet
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256((SECRET + "|drive").encode()).digest()))
def _enc(v: str) -> str: return _fernet().encrypt(v.encode()).decode()
def _dec(v: str) -> str: return _fernet().decrypt(v.encode()).decode()
def sget(s: Session, k: str) -> str:
    r = s.get(Setting, k); return r.value if r and r.value else ""
def sset(s: Session, k: str, v: str):
    r = s.get(Setting, k)
    if r: r.value = v
    else: s.add(Setting(key=k, value=v))
    s.commit()

def _drive_service(refresh: str):
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    cr = Credentials(None, refresh_token=refresh, token_uri="https://oauth2.googleapis.com/token", client_id=CID, client_secret=CSEC, scopes=[DSCOPE])
    return build("drive", "v3", credentials=cr, cache_discovery=False)

_dlock = threading.Lock()
def drive_push(files, refresh: str, folder_id: str):
    from googleapiclient.http import MediaFileUpload
    with _dlock:
        svc = _drive_service(refresh)
        for path, name in files:
            found = svc.files().list(q=f"name='{name}' and '{folder_id}' in parents and trashed=false", fields="files(id)").execute().get("files", [])
            media = MediaFileUpload(str(path))
            if found: svc.files().update(fileId=found[0]["id"], media_body=media).execute()
            else: svc.files().create(body={"name": name, "parents": [folder_id]}, media_body=media).execute()

def _drive_job(files, refresh: str, folder_id: str):
    s = Session_()
    try:
        drive_push(files, refresh, folder_id); sset(s, "drive_last_ok", dt.datetime.utcnow().isoformat()); sset(s, "drive_error", "")
    except Exception as e: sset(s, "drive_error", str(e)[:200])
    finally: s.close()

@app.get("/drive/connect")
def drive_connect(folder: str = "Pharmacy Manager Data", u: User = Depends(current("admin"))):
    if not CSEC: raise HTTPException(400, "Set GOOGLE_CLIENT_SECRET in backend/.env first")
    from urllib.parse import urlencode
    state = jwt.encode({"sub": str(u.id), "f": folder.strip()[:80] or "Pharmacy Manager Data", "exp": dt.datetime.utcnow() + dt.timedelta(minutes=10)}, SECRET)
    q = urlencode({"client_id": CID, "redirect_uri": REDIRECT, "response_type": "code", "scope": DSCOPE, "access_type": "offline",
                   "prompt": "consent select_account", "state": state})
    return {"url": "https://accounts.google.com/o/oauth2/v2/auth?" + q}

@app.get("/drive/callback")
def drive_callback(code: str = "", state: str = "", error: str = "", s: Session = Depends(db)):
    from fastapi.responses import RedirectResponse
    from urllib.parse import quote
    import requests
    def back(r, why=""):
        if why: print("Drive connect failed:", why)
        return RedirectResponse(f"{ORIGIN}/?drive={r}" + (f"&why={quote(why[:200])}" if why else ""))
    if error or not code: return back("denied", error or "Google returned no authorization code")
    try: st = jwt.decode(state, SECRET, algorithms=["HS256"]); admin = s.get(User, int(st["sub"]))
    except (JWTError, KeyError, ValueError): return back("error", "the connect request expired; please try again")
    if not admin or not admin.active or admin.role != "admin": return back("error", "only an active admin can connect Drive")
    try:
        r = requests.post("https://oauth2.googleapis.com/token", timeout=20, data={"code": code, "client_id": CID, "client_secret": CSEC, "redirect_uri": REDIRECT, "grant_type": "authorization_code"})
        tok = r.json()
    except Exception as e: return back("error", f"could not reach Google: {e}")
    if r.status_code != 200: return back("error", f"token exchange failed: {tok.get('error')} {tok.get('error_description', '')}")
    refresh = tok.get("refresh_token")
    if not refresh: return back("error", "Google sent no refresh token; remove this app at myaccount.google.com/permissions and connect again")
    try: f = _drive_service(refresh).files().create(body={"name": st["f"], "mimeType": "application/vnd.google-apps.folder"}, fields="id").execute()
    except Exception as e: return back("error", f"could not create the Drive folder: {e}")
    for k, v in (("drive_token", _enc(refresh)), ("drive_folder_id", f["id"]), ("drive_folder_name", st["f"]), ("drive_error", "")): sset(s, k, v)
    log(s, admin.email, f"connected Google Drive folder {st['f']}"); return back("connected")

@app.post("/drive/disconnect")
def drive_disconnect(u: User = Depends(current("admin")), s: Session = Depends(db)):
    ref = sget(s, "drive_token")
    if ref:
        try:
            import requests; requests.post("https://oauth2.googleapis.com/revoke", params={"token": _dec(ref)}, timeout=10)
        except Exception: pass
    for k in ("drive_token", "drive_folder_id", "drive_folder_name", "drive_error"): sset(s, k, "")
    log(s, u.email, "disconnected Google Drive"); return {"ok": True}

@app.get("/storage/status")
def storage_status(u: User = Depends(current("admin")), s: Session = Depends(db)):
    snaps = sorted(BACKUP.glob("pharmacy-2*.json"))
    return {"local_dir": str(BACKUP.resolve()), "local_count": len(snaps), "local_last": snaps[-1].stat().st_mtime if snaps else None,
            "drive_ready": bool(CSEC), "drive_connected": bool(sget(s, "drive_token")), "drive_folder": sget(s, "drive_folder_name"),
            "drive_last_ok": sget(s, "drive_last_ok"), "drive_error": sget(s, "drive_error"), "redirect_uri": REDIRECT,
            "mail_verified": sget(s, "mail_verified") == "1", "mail_email": sget(s, "mail_email"), "mail_pending": sget(s, "mail_p_email"),
            "mail_freq": sget(s, "mail_freq") or "off", "mail_last_ok": sget(s, "mail_last_ok"), "mail_error": sget(s, "mail_error")}

GMAIL = re.compile(r"^[A-Za-z0-9._%+-]{3,64}@(gmail|googlemail)\.com$")
MAIL_KEYS = ("mail_email", "mail_pw", "mail_verified", "mail_freq", "mail_error", "mail_last_ok", "mail_last_date")
PEND_KEYS = ("mail_p_email", "mail_p_pw", "mail_p_hash", "mail_p_exp", "mail_p_tries")
def _h(code: str) -> str: return hashlib.sha256((code + SECRET).encode()).hexdigest()
def _clear(s: Session, keys):
    for k in keys: sset(s, k, "")

def _smtp_send(addr: str, pw: str, subject: str, body: str, files=()):
    m = EmailMessage(); m["From"] = addr; m["To"] = addr; m["Subject"] = subject; m.set_content(body)
    for path, name in files:
        m.add_attachment(Path(path).read_bytes(), maintype="application", subtype="octet-stream", filename=name)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as srv:
        srv.login(addr, pw.replace(" ", "")); srv.send_message(m)

def _mail_job(addr: str, pw: str, files):
    s = Session_()
    try:
        _smtp_send(addr, pw, f"Pharmacy backup {dt.datetime.utcnow():%Y-%m-%d %H:%M} UTC",
                   "Backup of all pharmacy records (JSON + CSV files attached). This email contains business data: keep this mailbox private.", files)
        sset(s, "mail_last_ok", dt.datetime.utcnow().isoformat()); sset(s, "mail_error", "")
    except Exception as e: sset(s, "mail_error", str(e)[:200])
    finally: s.close()

class MailIn(BaseModel): email: str = Field(max_length=100); app_password: str = Field(min_length=8, max_length=64)
class CodeIn(BaseModel): code: str = Field(min_length=6, max_length=6)
class FreqIn(BaseModel): frequency: str

@app.post("/mail/send-code")
def mail_send_code(b: MailIn, u: User = Depends(current("admin")), s: Session = Depends(db)):
    addr = b.email.strip().lower()
    if not GMAIL.match(addr): raise HTTPException(400, "Enter a valid Gmail address (name@gmail.com)")
    code = f"{secrets.randbelow(10**6):06d}"
    try: _smtp_send(addr, b.app_password, "Your Pharmacy Manager verification code",
                    f"Your verification code is {code}. It expires in 10 minutes. If you did not request it, ignore this email.")
    except smtplib.SMTPAuthenticationError: raise HTTPException(400, "Gmail rejected the login. Use a 16-character App Password, not your normal password.")
    except Exception as e: raise HTTPException(400, f"Could not send the email: {e}"[:200])
    for k, v in (("mail_p_email", addr), ("mail_p_pw", _enc(b.app_password.replace(" ", ""))), ("mail_p_hash", _h(code)),
                 ("mail_p_exp", (dt.datetime.utcnow() + dt.timedelta(minutes=10)).isoformat()), ("mail_p_tries", "0")): sset(s, k, v)
    return {"ok": True}

@app.post("/mail/verify")
def mail_verify(b: CodeIn, u: User = Depends(current("admin")), s: Session = Depends(db)):
    if not sget(s, "mail_p_hash"): raise HTTPException(400, "Request a verification code first")
    tries = int(sget(s, "mail_p_tries") or 0)
    if tries >= 5 or dt.datetime.utcnow() > dt.datetime.fromisoformat(sget(s, "mail_p_exp")):
        _clear(s, PEND_KEYS); raise HTTPException(400, "Code expired or too many attempts. Request a new code.")
    if not hmac.compare_digest(_h(b.code), sget(s, "mail_p_hash")):
        sset(s, "mail_p_tries", str(tries + 1)); raise HTTPException(400, "Wrong code. Please check the email and try again.")
    for k, v in (("mail_email", sget(s, "mail_p_email")), ("mail_pw", sget(s, "mail_p_pw")), ("mail_verified", "1"), ("mail_freq", "daily"), ("mail_error", "")): sset(s, k, v)
    _clear(s, PEND_KEYS); log(s, u.email, "verified Gmail backup address"); return {"ok": True}

@app.post("/mail/settings")
def mail_settings(b: FreqIn, u: User = Depends(current("admin")), s: Session = Depends(db)):
    if b.frequency not in ("off", "daily"): raise HTTPException(400, "Bad option")
    sset(s, "mail_freq", b.frequency); return {"ok": True}

@app.post("/mail/disconnect")
def mail_disconnect(u: User = Depends(current("admin")), s: Session = Depends(db)):
    _clear(s, MAIL_KEYS + PEND_KEYS); log(s, u.email, "removed Gmail backup address"); return {"ok": True}
