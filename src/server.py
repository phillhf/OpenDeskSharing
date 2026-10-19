#!/usr/bin/env python3
"""
OpenDeskSharing – lokales, komplett offline betriebenes Raum- und Arbeitsplatz-Buchungstool.

Benötigt ausschließlich die Python-Standardbibliothek (Python 3.9+).
Alle Daten liegen lokal in data/opendesksharing.db (SQLite). Es werden keine externen
Dienste, CDNs, Tracker oder Cookies von Drittanbietern verwendet.

Start:  python server.py                 (Standard: Port 8080, alle Netzwerkschnittstellen)
        python server.py --host 127.0.0.1 --port 8080
        python server.py --https                (HTTPS mit automatisch erzeugtem Zertifikat)
        python server.py --cert cert.pem --key key.pem   (HTTPS mit eigenem Zertifikat)
"""
import argparse
import functools
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sqlite3
import ssl
import sys
import threading
import time
import traceback
from datetime import date, datetime, timedelta
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
import odsad  # noqa: E402  Windows-/AD-Anmeldung
import odstls  # noqa: E402  HTTPS-Zertifikate
import odsupdate  # noqa: E402  Updates von GitHub (nur auf Knopfdruck)
try:
    with open(os.path.join(BASE_DIR, "VERSION"), encoding="utf-8") as _vf:
        APP_VERSION = _vf.read().strip()
except OSError:
    APP_VERSION = "0.0.0-dev"
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "opendesksharing.db")

SESSION_COOKIE = "ods_session"
SESSION_HOURS = 12
MAX_BODY = 12 * 1024 * 1024  # 12 MB (Grundriss-Bilder)
PBKDF2_ITER = 240_000
USE_TLS = False
TLS_INFO = {}
VERBOSE = False

WRITE_LOCK = threading.Lock()
FAIL_LOCK = threading.Lock()
FAILED_LOGINS = {}  # username -> [fehlversuche, gesperrt_bis]

ROOM_KINDS = ("work", "meeting", "other")
DEFAULT_SETTINGS = {
    "company_name": "OpenDeskSharing",
    "max_days_ahead": "30",
    "day_start": "07:00",
    "day_end": "20:00",
    "default_start": "08:00",
    "default_end": "17:00",
    "allow_series": "1",
    "one_desk_per_user": "1",
    "holiday_state": "",
    "ad_enabled": "0",
    "ad_domain": "",
    "ad_user_group": "",
    "ad_admin_group": "",
}

FEATURE_SCOPES = ("desk", "room", "both")
CHECKIN_EARLY_MIN = 15  # so viele Minuten vor Beginn ist der Check-in möglich

# Spalten, die älteren Datenbanken nachträglich hinzugefügt werden
MIGRATIONS = {
    # access = JSON-Liste von Gruppen-IDs, die buchen dürfen ([] = keine Einschränkung auf dieser Ebene)
    "floors": [("access", "TEXT NOT NULL DEFAULT '[]'")],
    "users": [("auth", "TEXT NOT NULL DEFAULT 'local'"), ("ad_sid", "TEXT")],
    "buildings": [("state", "TEXT NOT NULL DEFAULT ''"), ("access", "TEXT NOT NULL DEFAULT '[]'")],
    "rooms": [("features", "TEXT NOT NULL DEFAULT '[]'"), ("access", "TEXT NOT NULL DEFAULT '[]'")],
    "desks": [("features", "TEXT NOT NULL DEFAULT '[]'")],
    "bookings": [("show_name", "INTEGER NOT NULL DEFAULT 0"), ("checkin", "TEXT"), ("checkout", "TEXT"), ("orig_end", "TEXT"),
                 ("attendees", "INTEGER")],
    "usage_archive": [("checkin", "TEXT"), ("orig_end", "TEXT"), ("attendees", "INTEGER")],
}
DEFAULT_FEATURES = [
    ("1 Monitor", "desk"), ("2 Monitore", "desk"), ("Dockingstation", "desk"), ("Höhenverstellbar", "desk"),
    ("Headset", "desk"), ("Fensterplatz", "both"), ("Ruhezone", "both"),
    ("TV / Display", "room"), ("Beamer", "room"), ("Whiteboard", "room"), ("Videokonferenz", "room"),
    ("Telefonkonferenz", "room"), ("Klimaanlage", "both"), ("Barrierefrei", "both"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    active INTEGER NOT NULL DEFAULT 1,
    must_change_pw INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS buildings (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS floors (
    id INTEGER PRIMARY KEY,
    building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 1200,
    height INTEGER NOT NULL DEFAULT 800,
    plan_image TEXT
);
CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,
    floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'work',
    capacity INTEGER NOT NULL DEFAULT 0,
    equipment TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    features TEXT NOT NULL DEFAULT '[]',
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS desks (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    equipment TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    features TEXT NOT NULL DEFAULT '[]',
    x REAL NOT NULL, y REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    desk_id INTEGER REFERENCES desks(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL,
    show_name INTEGER NOT NULL DEFAULT 0,
    checkin TEXT,
    checkout TEXT,
    orig_end TEXT,
    attendees INTEGER,
    CHECK ((desk_id IS NULL) <> (room_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_bookings_day ON bookings(day);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id, day);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS features (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'both',
    sort INTEGER NOT NULL DEFAULT 0
);
-- Anonymisierte Nutzungsdaten für Auswertungen (ohne Personenbezug)
CREATE TABLE IF NOT EXISTS usage_archive (
    id INTEGER PRIMARY KEY,
    desk_id INTEGER REFERENCES desks(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    checkin TEXT,
    orig_end TEXT,
    attendees INTEGER
);
CREATE INDEX IF NOT EXISTS idx_archive_day ON usage_archive(day);
CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    desk_id INTEGER REFERENCES desks(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
-- Feiertage und Schließtage (building_id NULL = alle Gebäude)
CREATE TABLE IF NOT EXISTS closures (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'closed',
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_closures_day ON closures(day);
-- Nicht erfüllter Bedarf: „nichts Passendes gefunden“ – bewusst OHNE Personenbezug gespeichert
CREATE TABLE IF NOT EXISTS demand (
    id INTEGER PRIMARY KEY,
    created TEXT NOT NULL,
    day TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    kind TEXT NOT NULL,
    building_id INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
    attendees INTEGER,
    features TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_demand_day ON demand(day);
-- Benutzergruppen (für Buchungsrechte); ad_group = optional verknüpfte AD-Gruppe
CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    ad_group TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);
"""

BOOKING_SELECT = """
SELECT b.id, b.user_id, b.desk_id, b.room_id, b.day, b.start, b.end, b.note, b.created,
       b.show_name, b.checkin, b.checkout, b.orig_end, b.attendees,
       u.display_name AS user_name, u.username AS username,
       d.name AS desk_name, COALESCE(r1.name, r2.name) AS room_name,
       f.id AS floor_id, f.name AS floor_name, bl.id AS building_id, bl.name AS building_name
FROM bookings b
JOIN users u ON u.id = b.user_id
LEFT JOIN desks d ON d.id = b.desk_id
LEFT JOIN rooms r1 ON r1.id = d.room_id
LEFT JOIN rooms r2 ON r2.id = b.room_id
JOIN floors f ON f.id = COALESCE(r1.floor_id, r2.floor_id)
JOIN buildings bl ON bl.id = f.building_id
"""

DATE_RX = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RX = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
USERNAME_RX = re.compile(r"^[A-Za-z0-9._@-]{2,64}$")
COLOR_RX = re.compile(r"^#[0-9a-fA-F]{6}$")
IMAGE_RX = re.compile(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$")


# --------------------------------------------------------------------------- Hilfsfunktionen

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def now_iso():
    return datetime.now().replace(microsecond=0).isoformat(sep=" ")


def sha256(s):
    return hashlib.sha256(s.encode()).hexdigest()


def hash_pw(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITER)
    return f"pbkdf2_sha256${PBKDF2_ITER}${salt.hex()}${dk.hex()}"


def verify_pw(pw, stored):
    try:
        _, it, salt, h = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(dk.hex(), h)
    except Exception:
        return False


def db_connect():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def get_settings(db):
    st = dict(DEFAULT_SETTINGS)
    for r in db.execute("SELECT key, value FROM settings"):
        st[r["key"]] = r["value"]
    return st


def s_str(v, field, maxlen=200, required=True):
    v = "" if v is None else str(v).strip()
    if required and not v:
        raise ApiError(400, f"Feld „{field}“ darf nicht leer sein")
    if len(v) > maxlen:
        raise ApiError(400, f"Feld „{field}“ ist zu lang (max. {maxlen} Zeichen)")
    return v


def s_int(v, field, lo=None, hi=None, default=None):
    if v in (None, ""):
        if default is not None:
            return default
        raise ApiError(400, f"Feld „{field}“ fehlt")
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ApiError(400, f"Feld „{field}“ muss eine Zahl sein")
    if (lo is not None and n < lo) or (hi is not None and n > hi):
        raise ApiError(400, f"Feld „{field}“ muss zwischen {lo} und {hi} liegen")
    return n


def s_float(v, field):
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ApiError(400, f"Feld „{field}“ muss eine Zahl sein")
    if f != f or abs(f) > 1e6:
        raise ApiError(400, f"Feld „{field}“ ist ungültig")
    return round(f, 1)


def opt_int(v):
    if v in (None, ""):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        raise ApiError(400, "Ungültige ID")


def parse_day(s):
    if not isinstance(s, str) or not DATE_RX.match(s):
        raise ApiError(400, "Ungültiges Datum")
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise ApiError(400, "Ungültiges Datum")


def parse_time(s, field="Uhrzeit"):
    if not isinstance(s, str) or not TIME_RX.match(s):
        raise ApiError(400, f"Ungültige {field} (Format HH:MM)")
    return s


def user_public(r):
    return {k: r[k] for k in ("id", "username", "display_name", "email", "department", "role", "active", "must_change_pw", "auth")}


# --------------------------------------------------------------------------- Initialisierung

def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    # Umbenennung Raumbuchung -> OpenDeskSharing: alte Datenbankdatei übernehmen
    legacy = os.path.join(DATA_DIR, "raum" + "buchung.db")
    if not os.path.exists(DB_PATH) and os.path.exists(legacy):
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(legacy + suffix):
                os.replace(legacy + suffix, DB_PATH + suffix)
        print(f"Datenbank übernommen: {legacy} -> {DB_PATH}")
    con = db_connect()
    con.execute("PRAGMA journal_mode = WAL")
    con.executescript(SCHEMA)
    # Migration älterer Datenbanken
    for table, adds in MIGRATIONS.items():
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        for col, decl in adds:
            if col not in cols:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    if not con.execute("SELECT 1 FROM settings WHERE key = 'features_seeded'").fetchone():
        if not con.execute("SELECT 1 FROM features LIMIT 1").fetchone():
            con.executemany("INSERT INTO features(name, scope, sort) VALUES (?,?,?)",
                            [(n, sc, i) for i, (n, sc) in enumerate(DEFAULT_FEATURES)])
        con.execute("INSERT INTO settings(key, value) VALUES ('features_seeded', '1')")
    for k, v in DEFAULT_SETTINGS.items():
        con.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
    # Seit 1.3.0 gelten gesetzliche Feiertage automatisch – früher per Knopf eingetragene Kopien entfernen
    st = con.execute("SELECT value FROM settings WHERE key = 'holiday_state'").fetchone()
    if st and st[0] in GERMAN_STATES:
        for cid, ds, name in con.execute("SELECT id, day, name FROM closures WHERE kind = 'holiday' AND building_id IS NULL").fetchall():
            if holiday_map(int(ds[:4]), st[0]).get(ds) == name:
                con.execute("DELETE FROM closures WHERE id = ?", (cid,))
    # alter Standardname -> neuer Name (eigene Namen bleiben unverändert)
    con.execute("UPDATE settings SET value = 'OpenDeskSharing' WHERE key = 'company_name' AND value = ?", ("Raum" + "buchung",))
    if not con.execute("SELECT 1 FROM users LIMIT 1").fetchone():
        pw = secrets.token_urlsafe(9)
        con.execute(
            "INSERT INTO users(username, display_name, password, role, must_change_pw, created) VALUES (?,?,?,?,1,?)",
            ("admin", "Administrator", hash_pw(pw), "admin", now_iso()),
        )
        info = os.path.join(DATA_DIR, "ERSTANMELDUNG.txt")
        with open(info, "w", encoding="utf-8") as f:
            f.write(
                "Erstanmeldung OpenDeskSharing\n\n"
                f"Benutzername: admin\nPasswort:     {pw}\n\n"
                "Das Passwort muss bei der ersten Anmeldung geändert werden.\n"
                "Diese Datei wird danach automatisch gelöscht.\n"
            )
        print("=" * 60)
        print(" Erster Start – Administrator-Konto wurde angelegt")
        print(f"   Benutzername: admin")
        print(f"   Passwort:     {pw}")
        print(f" (auch gespeichert in {info})")
        print("=" * 60)
    con.commit()
    con.close()


def archive_bookings(con, where, params):
    """Übernimmt vergangene Buchungen anonymisiert (ohne Person, ohne Notiz) in das Statistik-Archiv."""
    con.execute(
        "INSERT INTO usage_archive(desk_id, room_id, day, start, end, checkin, orig_end, attendees) "
        f"SELECT desk_id, room_id, day, start, end, checkin, orig_end, attendees FROM bookings WHERE day < ? AND ({where})",
        (date.today().isoformat(),) + tuple(params),
    )


def cleanup():
    """Abgelaufene Sitzungen entfernen. Buchungen werden bewusst NICHT automatisch gelöscht."""
    con = db_connect()
    try:
        con.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
        con.commit()
    finally:
        con.close()


def cleanup_loop():
    while True:
        try:
            cleanup()
        except Exception:
            traceback.print_exc()
        time.sleep(3600)


# --------------------------------------------------------------------------- Routing

ROUTES = []


def route(method, pattern, auth="user", pw_change_ok=False):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), auth, pw_change_ok, fn))
        return fn
    return deco


class Ctx:
    def __init__(self, db, user, query, body):
        self.db = db
        self.user = user
        self.query = query
        self.body = body if isinstance(body, dict) else {}
        self.set_cookie = None  # (token, max_age)

    def q(self, key, default=None):
        v = self.query.get(key)
        return v[0] if v else default

    @property
    def is_admin(self):
        return bool(self.user) and self.user["role"] == "admin"


# ---- Anmeldung / Profil ---------------------------------------------------

def _login_blocked(key):
    with FAIL_LOCK:
        ent = FAILED_LOGINS.get(key)
        if ent and ent[1] > time.time():
            raise ApiError(429, "Zu viele Fehlversuche. Bitte in 5 Minuten erneut versuchen.")


def _login_failed(key, message="Benutzername oder Passwort falsch"):
    with FAIL_LOCK:
        ent = FAILED_LOGINS.setdefault(key, [0, 0])
        ent[0] += 1
        if ent[0] >= 5:
            ent[0], ent[1] = 0, time.time() + 300
    raise ApiError(401, message)


def ad_enabled(st):
    return st.get("ad_enabled") == "1" and odsad.AVAILABLE


def ad_groups(st, db=None):
    g = {"user": st.get("ad_user_group", ""), "admin": st.get("ad_admin_group", "")}
    if db is not None:
        for r in db.execute("SELECT id, ad_group FROM groups WHERE ad_group <> ''"):
            g[f"g{r['id']}"] = r["ad_group"]
    return g


def ad_access(st, r):
    """(zugelassen?, Rolle oder None = unverändert, Begründung) aus den Gruppenmitgliedschaften."""
    is_admin = r["member"].get("admin", False)
    ug = st.get("ad_user_group", "").strip()
    if ug and not (r["member"].get("user") or is_admin):
        return False, None, f"Kein Zugang: Ihr Windows-Konto ist nicht in der Gruppe „{ug}“"
    role = ("admin" if is_admin else "user") if st.get("ad_admin_group", "").strip() else None
    return True, role, ""


def ad_login(c, st, login, pw, key):
    try:
        r = odsad.authenticate(login, pw, st.get("ad_domain", ""), ad_groups(st, c.db))
    except odsad.AdError as e:
        if e.kind in ("credentials", "account"):
            _login_failed(key, e.message)
        print(f"[{now_iso()}] Windows-Anmeldung nicht möglich: {e.message}")
        raise ApiError(503, "Windows-Anmeldung derzeit nicht möglich: " + e.message)
    linked_err = {k: v for k, v in r["group_errors"].items() if k.startswith("g")}
    if linked_err:
        # falsch eingetragene AD-Gruppe bei einer Benutzergruppe: Anmeldung trotzdem erlauben, Mitgliedschaft unverändert lassen
        print(f"[{now_iso()}] Windows-Anmeldung: verknüpfte AD-Gruppe nicht gefunden: {'; '.join(linked_err.values())}")
    r["group_errors"] = {k: v for k, v in r["group_errors"].items() if not k.startswith("g")}
    if r["group_errors"]:
        print(f"[{now_iso()}] Windows-Anmeldung: Gruppeneinstellung fehlerhaft: {'; '.join(r['group_errors'].values())}")
        raise ApiError(503, "Anmeldung nicht möglich: Die AD-Gruppen sind in OpenDeskSharing falsch eingestellt. Bitte den Administrator informieren.")
    ok, role, why = ad_access(st, r)
    if not ok:
        raise ApiError(403, why)
    db = c.db
    row = db.execute("SELECT * FROM users WHERE ad_sid = ?", (r["sid"],)).fetchone()
    if not row:
        row = db.execute("SELECT * FROM users WHERE username = ?", (r["username"],)).fetchone()
        if row and (row["auth"] != "ad" or (row["ad_sid"] and row["ad_sid"] != r["sid"])):
            raise ApiError(409, f"Der Benutzername „{r['username']}“ ist in OpenDeskSharing bereits an ein anderes Konto vergeben. "
                                "Bitte den Administrator informieren.")
    if row:
        if not row["active"]:
            raise ApiError(401, "Ihr Zugang zu OpenDeskSharing wurde deaktiviert")
        new_role = role or row["role"]
        if row["role"] == "admin" and new_role != "admin" and _admin_count(db, row["id"]) == 0:
            new_role = "admin"  # nie den letzten Administrator verlieren
            print(f"[{now_iso()}] Hinweis: {r['username']} ist nicht mehr in der Admin-Gruppe, bleibt aber Administrator (letzter Administrator)")
        db.execute("UPDATE users SET username = ?, display_name = ?, ad_sid = ?, role = ?, auth = 'ad', must_change_pw = 0 WHERE id = ?",
                   (r["username"], r["display_name"], r["sid"], new_role, row["id"]))
        uid = row["id"]
    else:
        uid = db.execute(
            "INSERT INTO users(username, display_name, password, role, active, must_change_pw, created, auth, ad_sid)"
            " VALUES (?,?,'',?,1,0,?,'ad',?)",
            (r["username"], r["display_name"], role or "user", now_iso(), r["sid"]),
        ).lastrowid
    # Mitgliedschaft in Benutzergruppen, die mit einer AD-Gruppe verknüpft sind, aus dem AD übernehmen
    for key, is_member in r["member"].items():
        if not key.startswith("g") or key in linked_err:
            continue
        gid = int(key[1:])
        if is_member:
            db.execute("INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES (?, ?)", (uid, gid))
        else:
            db.execute("DELETE FROM user_groups WHERE user_id = ? AND group_id = ?", (uid, gid))
    return db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()


@route("POST", "/api/login", auth=None)
def api_login(c):
    username = str(c.body.get("username", "")).strip()
    pw = str(c.body.get("password", ""))
    key = odsad.split_login(username)[0].lower()
    _login_blocked(key)
    st = get_settings(c.db)
    row = c.db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row is None and "\\" in username:
        # „FIRMA\\max“ -> Konto „max“
        row = c.db.execute("SELECT * FROM users WHERE username = ? AND auth = 'ad'", (odsad.split_login(username)[0],)).fetchone()
    if row is not None and row["auth"] != "ad":
        if not verify_pw(pw, row["password"]) or not row["active"]:
            _login_failed(key)
    elif ad_enabled(st):
        row = ad_login(c, st, username, pw, key)
    elif row is not None:
        _login_failed(key, "Die Windows-Anmeldung ist derzeit ausgeschaltet. Bitte den Administrator fragen.")
    else:
        _login_failed(key)
    with FAIL_LOCK:
        FAILED_LOGINS.pop(key, None)
    token = secrets.token_urlsafe(32)
    c.db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (sha256(token), row["id"], time.time() + SESSION_HOURS * 3600))
    c.set_cookie = (token, SESSION_HOURS * 3600)
    return {"ok": True}


@route("POST", "/api/logout", auth=None)
def api_logout(c):
    if c.user:
        c.db.execute("DELETE FROM sessions WHERE token_hash = ?", (c.user["_token_hash"],))
    c.set_cookie = ("", 0)
    return {"ok": True}


@route("GET", "/api/me", auth=None)
def api_me(c):
    if not c.user:
        st = get_settings(c.db)
        return {"user": None, "login": {"ad": ad_enabled(st), "domain": st["ad_domain"], "company_name": st["company_name"],
                                        "ca": bool(TLS_INFO.get("ca_file"))}}
    groups = [r[0] for r in c.db.execute("SELECT g.name FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ? "
                                         "ORDER BY g.name COLLATE NOCASE", (c.user["id"],))]
    return {"user": user_public(c.user) | {"groups": groups}, "settings": get_settings(c.db), "version": APP_VERSION}


@route("GET", "/api/version", auth=None)
def api_version(c):
    """Für die Funktionsprüfung nach Installation/Update."""
    return {"version": APP_VERSION}


@route("POST", "/api/me/password", pw_change_ok=True)
def api_change_pw(c):
    old = str(c.body.get("old_password", ""))
    new = str(c.body.get("new_password", ""))
    if c.user["auth"] == "ad":
        raise ApiError(400, "Sie melden sich mit Ihrem Windows-Konto an – das Passwort wird in Windows geändert")
    if not verify_pw(old, c.user["password"]):
        raise ApiError(400, "Aktuelles Passwort ist falsch")
    if len(new) < 8:
        raise ApiError(400, "Das neue Passwort muss mindestens 8 Zeichen lang sein")
    if new == old:
        raise ApiError(400, "Das neue Passwort muss sich vom alten unterscheiden")
    c.db.execute("UPDATE users SET password = ?, must_change_pw = 0 WHERE id = ?", (hash_pw(new), c.user["id"]))
    # alle anderen Sitzungen des Benutzers beenden
    c.db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", (c.user["id"], c.user["_token_hash"]))
    info = os.path.join(DATA_DIR, "ERSTANMELDUNG.txt")
    if c.user["username"].lower() == "admin" and os.path.exists(info):
        try:
            os.remove(info)
        except OSError:
            pass
    return {"ok": True}


@route("GET", "/api/me/export")
def api_me_export(c):
    """DSGVO Art. 15 – Auskunft über die eigenen gespeicherten Daten."""
    rows = c.db.execute(BOOKING_SELECT + " WHERE b.user_id = ? ORDER BY b.day, b.start", (c.user["id"],)).fetchall()
    u = user_public(c.user)
    u["created"] = c.user["created"]
    u["gruppen"] = [r[0] for r in c.db.execute("SELECT g.name FROM groups g JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ?",
                                               (c.user["id"],))]
    return {
        "exportiert_am": now_iso(),
        "benutzer": u,
        "buchungen": [
            {k: r[k] for k in ("day", "start", "end", "building_name", "floor_name", "room_name", "desk_name", "note", "created",
                               "show_name", "checkin", "checkout", "orig_end")}
            for r in rows
        ],
    }


# ---- Einstellungen ------------------------------------------------------------

@route("GET", "/api/settings")
def api_settings(c):
    return get_settings(c.db)


@route("PUT", "/api/settings", auth="admin")
def api_settings_put(c):
    b = c.body
    vals = {}
    if "company_name" in b:
        vals["company_name"] = s_str(b["company_name"], "Name", 80)
    if "max_days_ahead" in b:
        vals["max_days_ahead"] = str(s_int(b["max_days_ahead"], "Tage im Voraus", 0, 365))
    for k in ("day_start", "day_end", "default_start", "default_end"):
        if k in b:
            vals[k] = parse_time(b[k])
    if "holiday_state" in b:
        if b["holiday_state"] not in ("",) + tuple(GERMAN_STATES):
            raise ApiError(400, "Ungültiges Bundesland")
        vals["holiday_state"] = b["holiday_state"]
    for k, label in (("ad_domain", "Domäne"), ("ad_user_group", "Benutzer-Gruppe"), ("ad_admin_group", "Admin-Gruppe")):
        if k in b:
            vals[k] = s_str(b[k], label, 150, required=False)
    for k in ("allow_series", "one_desk_per_user", "ad_enabled"):
        if k in b:
            vals[k] = "1" if b[k] in (True, 1, "1", "true") else "0"
    merged = {**get_settings(c.db), **vals}
    if merged["day_start"] >= merged["day_end"]:
        raise ApiError(400, "Buchbarer Zeitraum: Beginn muss vor Ende liegen")
    if not (merged["day_start"] <= merged["default_start"] < merged["default_end"] <= merged["day_end"]):
        raise ApiError(400, "Standardzeiten müssen innerhalb des buchbaren Zeitraums liegen")
    if merged["ad_enabled"] == "1":
        if not odsad.AVAILABLE:
            raise ApiError(400, "Die Windows-Anmeldung ist nur verfügbar, wenn der Server unter Windows läuft")
        if not merged["ad_domain"]:
            raise ApiError(400, "Bitte die Domäne angeben (z. B. FIRMA) – oder „.“ für lokale Konten dieses Servers")
    for k, v in vals.items():
        c.db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, v))
    if vals.get("ad_enabled") == "0":
        # Windows-Anmeldung ausgeschaltet: angemeldete Windows-Benutzer sofort abmelden
        c.db.execute("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE auth = 'ad')")
    return get_settings(c.db)


@route("POST", "/api/ad/test", auth="admin")
def api_ad_test(c):
    """Prüft eine Windows-Anmeldung mit den (noch nicht gespeicherten) Einstellungen – legt nichts an."""
    b = c.body
    key = "adtest:" + str(c.user["id"])
    _login_blocked(key)
    st = {"ad_domain": s_str(b.get("ad_domain"), "Domäne", 150, required=False),
          "ad_user_group": s_str(b.get("ad_user_group"), "Benutzer-Gruppe", 150, required=False),
          "ad_admin_group": s_str(b.get("ad_admin_group"), "Admin-Gruppe", 150, required=False)}
    if not odsad.AVAILABLE:
        return {"ok": False, "error": "Die Windows-Anmeldung ist nur verfügbar, wenn der Server unter Windows läuft"}
    if not st["ad_domain"]:
        return {"ok": False, "error": "Bitte zuerst die Domäne angeben"}
    try:
        r = odsad.authenticate(str(b.get("username", "")), str(b.get("password", "")), st["ad_domain"], ad_groups(st))
    except odsad.AdError as e:
        if e.kind == "credentials":
            with FAIL_LOCK:
                ent = FAILED_LOGINS.setdefault(key, [0, 0])
                ent[0] += 1
                if ent[0] >= 5:
                    ent[0], ent[1] = 0, time.time() + 300
        return {"ok": False, "error": e.message, "code": e.code}
    ok, role, why = ad_access(st, r) if not r["group_errors"] else (False, None, "")
    existing = c.db.execute("SELECT username, role, auth FROM users WHERE ad_sid = ? OR username = ?", (r["sid"], r["username"])).fetchone()
    return {"ok": True, "username": r["username"], "domain": r["domain"], "display_name": r["display_name"],
            "member": r["member"], "group_errors": r["group_errors"], "access": ok, "reason": why,
            "role": role or (existing["role"] if existing else "user"), "role_from_group": role is not None,
            "existing": dict(existing) if existing else None}


@route("GET", "/api/update/check", auth="admin")
def api_update_check(c):
    """Nur auf Knopfdruck: neueste Version auf GitHub abfragen."""
    try:
        return odsupdate.check(APP_VERSION, BASE_DIR)
    except odsupdate.UpdateError as e:
        raise ApiError(502, str(e))


@route("POST", "/api/update/install", auth="admin")
def api_update_install(c):
    try:
        return odsupdate.install(APP_VERSION, BASE_DIR, log=lambda m: print(f"[{now_iso()}] {m}"))
    except odsupdate.UpdateError as e:
        raise ApiError(502, str(e))


@route("GET", "/api/tls", auth="admin")
def api_tls(c):
    return {"enabled": USE_TLS, **{k: v for k, v in TLS_INFO.items() if k != "ca_file"}, "ca_download": bool(TLS_INFO.get("ca_file"))}


# ---- Benutzer -----------------------------------------------------------------

@route("GET", "/api/users", auth="admin")
def api_users(c):
    ug = {}
    for r in c.db.execute("SELECT user_id, group_id FROM user_groups"):
        ug.setdefault(r[0], []).append(r[1])
    return [user_public(r) | {"groups": sorted(ug.get(r["id"], []))} for r in c.db.execute("SELECT * FROM users ORDER BY display_name COLLATE NOCASE")]


def _user_fields(b, partial=False):
    out = {}
    if not partial or "display_name" in b:
        out["display_name"] = s_str(b.get("display_name"), "Name", 100)
    if not partial or "email" in b:
        out["email"] = s_str(b.get("email"), "E-Mail", 150, required=False)
    if not partial or "department" in b:
        out["department"] = s_str(b.get("department"), "Abteilung", 100, required=False)
    if not partial or "role" in b:
        role = b.get("role", "user")
        if role not in ("user", "admin"):
            raise ApiError(400, "Ungültige Rolle")
        out["role"] = role
    if "active" in b:
        out["active"] = 1 if b["active"] in (True, 1, "1") else 0
    return out


def _auth(v):
    v = v or "local"
    if v not in ("local", "ad"):
        raise ApiError(400, "Ungültige Anmeldeart")
    return v


@route("POST", "/api/users", auth="admin")
def api_user_create(c):
    b = c.body
    auth = _auth(b.get("auth"))
    username = s_str(b.get("username"), "Benutzername", 64)
    if auth == "ad":
        username = odsad.split_login(username)[0]
        if not username or "@" in username:
            raise ApiError(400, "Bitte den Windows-Anmeldenamen ohne Domäne angeben (z. B. mmustermann)")
    elif not USERNAME_RX.match(username):
        raise ApiError(400, "Benutzername: 2–64 Zeichen, erlaubt sind Buchstaben, Ziffern und . _ @ -")
    pw = str(b.get("password", ""))
    if auth == "local" and len(pw) < 8:
        raise ApiError(400, "Das Passwort muss mindestens 8 Zeichen lang sein")
    f = _user_fields(b)
    if c.db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        raise ApiError(409, "Benutzername ist bereits vergeben")
    cur = c.db.execute(
        "INSERT INTO users(username, display_name, email, department, role, active, password, must_change_pw, created, auth)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (username, f["display_name"], f["email"], f["department"], f["role"], f.get("active", 1),
         hash_pw(pw) if auth == "local" else "", 1 if auth == "local" else 0, now_iso(), auth),
    )
    if "groups" in b:
        set_user_groups(c.db, cur.lastrowid, b["groups"])
    return user_public(c.db.execute("SELECT * FROM users WHERE id = ?", (cur.lastrowid,)).fetchone())


def _admin_count(db, exclude_id):
    return db.execute("SELECT COUNT(*) FROM users WHERE role='admin' AND active=1 AND id<>?", (exclude_id,)).fetchone()[0]


@route("PUT", r"/api/users/(\d+)", auth="admin")
def api_user_update(c, uid):
    uid = int(uid)
    row = c.db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if not row:
        raise ApiError(404, "Benutzer nicht gefunden")
    f = _user_fields(c.body, partial=True)
    demote = f.get("role", row["role"]) != "admin" or f.get("active", row["active"]) == 0
    if row["role"] == "admin" and demote and _admin_count(c.db, uid) == 0:
        raise ApiError(400, "Es muss mindestens ein aktiver Administrator bestehen bleiben")
    for k, v in f.items():
        c.db.execute(f"UPDATE users SET {k} = ? WHERE id = ?", (v, uid))
    auth = _auth(c.body.get("auth") or row["auth"])
    pw = str(c.body.get("password") or "")
    if auth == "ad":
        pw = ""
        if row["auth"] != "ad":
            c.db.execute("UPDATE users SET auth = 'ad', password = '', must_change_pw = 0 WHERE id = ?", (uid,))
    elif row["auth"] == "ad":
        if len(pw) < 8:
            raise ApiError(400, "Für die Umstellung auf ein OpenDeskSharing-Passwort bitte ein Startpasswort (mind. 8 Zeichen) vergeben")
        c.db.execute("UPDATE users SET auth = 'local', ad_sid = NULL WHERE id = ?", (uid,))
    if pw:
        if len(pw) < 8:
            raise ApiError(400, "Das Passwort muss mindestens 8 Zeichen lang sein")
        c.db.execute("UPDATE users SET password = ?, must_change_pw = 1 WHERE id = ?", (hash_pw(pw), uid))
    if "groups" in c.body:
        set_user_groups(c.db, uid, c.body["groups"])
    if pw or f.get("active") == 0 or auth != row["auth"]:
        c.db.execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
    return user_public(c.db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone())


@route("DELETE", r"/api/users/(\d+)", auth="admin")
def api_user_delete(c, uid):
    uid = int(uid)
    if uid == c.user["id"]:
        raise ApiError(400, "Sie können sich nicht selbst löschen")
    row = c.db.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
    if not row:
        raise ApiError(404, "Benutzer nicht gefunden")
    if row["role"] == "admin" and _admin_count(c.db, uid) == 0:
        raise ApiError(400, "Der letzte Administrator kann nicht gelöscht werden")
    archive_bookings(c.db, "user_id = ?", (uid,))  # Statistik bleibt anonym erhalten
    c.db.execute("DELETE FROM users WHERE id = ?", (uid,))  # Buchungen & Sitzungen per CASCADE
    return {"ok": True}


# ---- Benutzergruppen ------------------------------------------------------------------

def _group_out(db, g):
    o = dict(g)
    o["members"] = [r[0] for r in db.execute("SELECT user_id FROM user_groups WHERE group_id = ?", (g["id"],))]
    uses = []
    for tbl, label in (("buildings", "Gebäude"), ("floors", "Etage"), ("rooms", "Raum")):
        for r in db.execute(f"SELECT id, name, access FROM {tbl} WHERE access <> '[]'"):
            if g["id"] in access_ids(r["access"]):
                uses.append(f"{label} {r['name']}")
    o["used_by"] = uses
    return o


@route("GET", "/api/groups", auth="admin")
def api_groups(c):
    return [_group_out(c.db, g) for g in c.db.execute("SELECT * FROM groups ORDER BY name COLLATE NOCASE")]


def _group_save(c, gid=None):
    b = c.body
    name = s_str(b.get("name"), "Gruppenname", 80)
    desc = s_str(b.get("description"), "Beschreibung", 200, False)
    adg = s_str(b.get("ad_group"), "AD-Gruppe", 150, False)
    if c.db.execute("SELECT 1 FROM groups WHERE name = ? AND id IS NOT ?", (name, gid)).fetchone():
        raise ApiError(409, "Eine Gruppe mit diesem Namen gibt es bereits")
    if gid is None:
        gid = c.db.execute("INSERT INTO groups(name, description, ad_group) VALUES (?,?,?)", (name, desc, adg)).lastrowid
    elif not c.db.execute("UPDATE groups SET name = ?, description = ?, ad_group = ? WHERE id = ?", (name, desc, adg, gid)).rowcount:
        raise ApiError(404, "Gruppe nicht gefunden")
    if "members" in b:
        if not isinstance(b["members"], list):
            raise ApiError(400, "Ungültige Mitgliederliste")
        valid = {r[0] for r in c.db.execute("SELECT id FROM users")}
        c.db.execute("DELETE FROM user_groups WHERE group_id = ?", (gid,))
        c.db.executemany("INSERT INTO user_groups(user_id, group_id) VALUES (?, ?)",
                         [(u, gid) for u in {x for x in b["members"] if isinstance(x, int) and x in valid}])
    return _group_out(c.db, c.db.execute("SELECT * FROM groups WHERE id = ?", (gid,)).fetchone())


@route("POST", "/api/groups", auth="admin")
def api_group_create(c):
    return _group_save(c)


@route("PUT", r"/api/groups/(\d+)", auth="admin")
def api_group_update(c, gid):
    return _group_save(c, int(gid))


@route("DELETE", r"/api/groups/(\d+)", auth="admin")
def api_group_delete(c, gid):
    gid = int(gid)
    # aus allen Buchungsrechten entfernen – bleibt eine Ebene danach ohne Gruppe, ist sie wieder für alle buchbar
    for tbl in ("buildings", "floors", "rooms"):
        for r in c.db.execute(f"SELECT id, access FROM {tbl} WHERE access <> '[]'").fetchall():
            ids = access_ids(r["access"])
            if gid in ids:
                c.db.execute(f"UPDATE {tbl} SET access = ? WHERE id = ?", (json.dumps([x for x in ids if x != gid]), r["id"]))
    c.db.execute("DELETE FROM groups WHERE id = ?", (gid,))
    return {"ok": True}


def set_user_groups(db, uid, v):
    if not isinstance(v, list):
        raise ApiError(400, "Ungültige Gruppenauswahl")
    valid = {r[0] for r in db.execute("SELECT id FROM groups")}
    db.execute("DELETE FROM user_groups WHERE user_id = ?", (uid,))
    db.executemany("INSERT INTO user_groups(user_id, group_id) VALUES (?, ?)", [(uid, g) for g in {x for x in v if isinstance(x, int) and x in valid}])


# ---- Gebäude & Etagen -------------------------------------------------------------

@route("GET", "/api/buildings")
def api_buildings(c):
    bs = [dict(r) for r in c.db.execute("SELECT * FROM buildings ORDER BY sort, name COLLATE NOCASE")]
    for b in bs:
        b["access"] = access_ids(b["access"])
    floors = c.db.execute(
        """SELECT f.id, f.building_id, f.name, f.sort, f.width, f.height, f.access, (f.plan_image IS NOT NULL) AS has_plan,
                  (SELECT COUNT(*) FROM rooms r WHERE r.floor_id = f.id) AS room_count,
                  (SELECT COUNT(*) FROM desks d JOIN rooms r ON r.id = d.room_id WHERE r.floor_id = f.id) AS desk_count
           FROM floors f ORDER BY f.sort, f.name COLLATE NOCASE"""
    ).fetchall()
    for b in bs:
        b["floors"] = [dict(f) | {"access": access_ids(f["access"])} for f in floors if f["building_id"] == b["id"]]
    return bs


def _state(v):
    v = v or ""
    if v and v not in GERMAN_STATES:
        raise ApiError(400, "Ungültiges Bundesland")
    return v


@route("POST", "/api/buildings", auth="admin")
def api_building_create(c):
    b = c.body
    cur = c.db.execute(
        "INSERT INTO buildings(name, address, sort, state, access) VALUES (?,?,?,?,?)",
        (s_str(b.get("name"), "Name", 100), s_str(b.get("address"), "Adresse", 200, False), s_int(b.get("sort"), "Sortierung", -9999, 9999, 0),
         _state(b.get("state")), clean_access(c.db, b.get("access"))),
    )
    return {"id": cur.lastrowid}


@route("PUT", r"/api/buildings/(\d+)", auth="admin")
def api_building_update(c, bid):
    b = c.body
    n = c.db.execute(
        "UPDATE buildings SET name=?, address=?, sort=?, state=?, access=? WHERE id=?",
        (s_str(b.get("name"), "Name", 100), s_str(b.get("address"), "Adresse", 200, False), s_int(b.get("sort"), "Sortierung", -9999, 9999, 0),
         _state(b.get("state")), clean_access(c.db, b.get("access")), int(bid)),
    ).rowcount
    if not n:
        raise ApiError(404, "Gebäude nicht gefunden")
    return {"ok": True}


@route("DELETE", r"/api/buildings/(\d+)", auth="admin")
def api_building_delete(c, bid):
    c.db.execute("DELETE FROM buildings WHERE id = ?", (int(bid),))
    return {"ok": True}


@route("POST", "/api/floors", auth="admin")
def api_floor_create(c):
    b = c.body
    bid = s_int(b.get("building_id"), "Gebäude")
    if not c.db.execute("SELECT 1 FROM buildings WHERE id = ?", (bid,)).fetchone():
        raise ApiError(404, "Gebäude nicht gefunden")
    cur = c.db.execute(
        "INSERT INTO floors(building_id, name, sort, access) VALUES (?,?,?,?)",
        (bid, s_str(b.get("name"), "Name", 100), s_int(b.get("sort"), "Sortierung", -9999, 9999, 0), clean_access(c.db, b.get("access"))),
    )
    return {"id": cur.lastrowid}


@route("PUT", r"/api/floors/(\d+)", auth="admin")
def api_floor_update(c, fid):
    b = c.body
    n = c.db.execute(
        "UPDATE floors SET name=?, sort=?, access=? WHERE id=?",
        (s_str(b.get("name"), "Name", 100), s_int(b.get("sort"), "Sortierung", -9999, 9999, 0), clean_access(c.db, b.get("access")), int(fid)),
    ).rowcount
    if not n:
        raise ApiError(404, "Etage nicht gefunden")
    return {"ok": True}


@route("DELETE", r"/api/floors/(\d+)", auth="admin")
def api_floor_delete(c, fid):
    c.db.execute("DELETE FROM floors WHERE id = ?", (int(fid),))
    return {"ok": True}


# ---- Buchungsrechte ---------------------------------------------------------------
# Auf Gebäude, Etage und Raum kann festgelegt werden, welche Gruppen buchen dürfen. Es gilt die nächste
# Ebene mit einer Festlegung (Raum vor Etage vor Gebäude); ohne Festlegung darf jeder buchen.
# Arbeitsplätze erben vom Raum. Administratoren dürfen immer buchen.

def access_ids(v):
    try:
        return sorted({int(x) for x in json.loads(v or "[]")})
    except (ValueError, TypeError):
        return []


def clean_access(db, v):
    if v in (None, ""):
        return "[]"
    if not isinstance(v, list):
        raise ApiError(400, "Ungültige Gruppenauswahl")
    valid = {r[0] for r in db.execute("SELECT id FROM groups")}
    return json.dumps(sorted({int(x) for x in v if isinstance(x, int) and x in valid}))


def effective_access(*levels):
    """levels: access-JSON von Raum, Etage, Gebäude -> (Gruppen-IDs, Ebene) der nächsten Festlegung."""
    for name, v in zip(("room", "floor", "building"), levels):
        ids = access_ids(v)
        if ids:
            return ids, name
    return [], None


def user_groups(db, uid):
    return {r[0] for r in db.execute("SELECT group_id FROM user_groups WHERE user_id = ?", (uid,))}


def group_names(db):
    return {r[0]: r[1] for r in db.execute("SELECT id, name FROM groups")}


def may_book(user, mine, eff):
    return not eff or user["role"] == "admin" or bool(mine & set(eff))


def room_access(db, room_id):
    r = db.execute("SELECT r.access AS ra, f.access AS fa, b.access AS ba FROM rooms r JOIN floors f ON f.id = r.floor_id "
                   "JOIN buildings b ON b.id = f.building_id WHERE r.id = ?", (room_id,)).fetchone()
    return effective_access(r["ra"], r["fa"], r["ba"])[0] if r else []


def check_access(c, room_id):
    eff = room_access(c.db, room_id)
    if not may_book(c.user, user_groups(c.db, c.user["id"]), eff):
        names = group_names(c.db)
        raise ApiError(403, "Nur buchbar für: " + ", ".join(names.get(g, "?") for g in eff))


def load_floor(db, fid, user=None):
    f = db.execute("SELECT f.*, b.access AS building_access FROM floors f JOIN buildings b ON b.id = f.building_id WHERE f.id = ?",
                   (fid,)).fetchone()
    if not f:
        raise ApiError(404, "Etage nicht gefunden")
    out = dict(f)
    out["access"] = access_ids(f["access"])
    out["building_access"] = access_ids(f["building_access"])
    mine = user_groups(db, user["id"]) if user else set()
    names = group_names(db)
    allowed = {}
    out["rooms"] = []
    for r in db.execute("SELECT * FROM rooms WHERE floor_id = ? ORDER BY name COLLATE NOCASE", (fid,)):
        o = with_features(r)
        eff, level = effective_access(r["access"], f["access"], f["building_access"])
        o["access"] = access_ids(r["access"])
        o["access_names"] = [names.get(g, "?") for g in eff]
        o["access_from"] = level
        o["allowed"] = allowed[r["id"]] = may_book(user, mine, eff) if user else True
        out["rooms"].append(o)
    out["desks"] = []
    for d in db.execute("SELECT d.* FROM desks d JOIN rooms r ON r.id = d.room_id WHERE r.floor_id = ? ORDER BY d.name COLLATE NOCASE", (fid,)):
        o = with_features(d)
        o["allowed"] = allowed.get(d["room_id"], True)
        out["desks"].append(o)
    return out


def with_features(row):
    o = dict(row)
    try:
        o["features"] = [int(x) for x in json.loads(o.get("features") or "[]")]
    except (ValueError, TypeError):
        o["features"] = []
    return o


def clean_features(v, valid):
    if not isinstance(v, list):
        return "[]"
    return json.dumps(sorted({x for x in v if isinstance(x, int) and x in valid}))


@route("GET", r"/api/floors/(\d+)")
def api_floor_get(c, fid):
    return load_floor(c.db, int(fid), c.user)


@route("PUT", r"/api/floors/(\d+)/layout", auth="admin")
def api_floor_layout(c, fid):
    fid = int(fid)
    load_floor(c.db, fid)  # existiert?
    b = c.body
    width = s_int(b.get("width"), "Breite", 200, 10000, 1200)
    height = s_int(b.get("height"), "Höhe", 200, 10000, 800)
    c.db.execute("UPDATE floors SET width=?, height=? WHERE id=?", (width, height, fid))
    if "plan_image" in b:
        img = b["plan_image"]
        if img in (None, ""):
            c.db.execute("UPDATE floors SET plan_image = NULL WHERE id = ?", (fid,))
        else:
            if not isinstance(img, str) or not IMAGE_RX.match(img):
                raise ApiError(400, "Grundriss muss ein PNG-, JPEG-, GIF- oder WebP-Bild sein")
            c.db.execute("UPDATE floors SET plan_image = ? WHERE id = ?", (img, fid))

    rooms_in = b.get("rooms") or []
    desks_in = b.get("desks") or []
    if not isinstance(rooms_in, list) or not isinstance(desks_in, list):
        raise ApiError(400, "Ungültiges Layout")

    valid_features = {r[0] for r in c.db.execute("SELECT id FROM features")}
    existing_rooms = {r[0] for r in c.db.execute("SELECT id FROM rooms WHERE floor_id = ?", (fid,))}
    idmap, keep = {}, set()
    for r in rooms_in:
        if not isinstance(r, dict):
            raise ApiError(400, "Ungültiger Raum")
        kind = r.get("kind", "work")
        if kind not in ROOM_KINDS:
            raise ApiError(400, "Ungültiger Raumtyp")
        color = str(r.get("color") or "")
        if color and not COLOR_RX.match(color):
            color = ""
        vals = (
            s_str(r.get("name"), "Raumname", 100), kind, s_int(r.get("capacity"), "Kapazität", 0, 10000, 0),
            s_str(r.get("equipment"), "Ausstattung", 300, False), color, clean_features(r.get("features"), valid_features),
            s_float(r.get("x"), "x"), s_float(r.get("y"), "y"),
            max(10.0, s_float(r.get("w"), "Breite")), max(10.0, s_float(r.get("h"), "Höhe")), clean_access(c.db, r.get("access")),
        )
        rid = r.get("id")
        if isinstance(rid, int) and rid in existing_rooms:
            c.db.execute("UPDATE rooms SET name=?, kind=?, capacity=?, equipment=?, color=?, features=?, x=?, y=?, w=?, h=?, access=? WHERE id=?", vals + (rid,))
            idmap[str(rid)] = rid
            keep.add(rid)
        else:
            cur = c.db.execute("INSERT INTO rooms(name, kind, capacity, equipment, color, features, x, y, w, h, access, floor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", vals + (fid,))
            idmap[str(rid)] = cur.lastrowid
    for rid in existing_rooms - keep:
        c.db.execute("DELETE FROM rooms WHERE id = ?", (rid,))

    existing_desks = {
        d[0] for d in c.db.execute("SELECT d.id FROM desks d JOIN rooms r ON r.id = d.room_id WHERE r.floor_id = ?", (fid,))
    }
    keep_d = set()
    for d in desks_in:
        if not isinstance(d, dict):
            raise ApiError(400, "Ungültiger Arbeitsplatz")
        room_id = idmap.get(str(d.get("room")))
        if room_id is None:
            raise ApiError(400, f"Arbeitsplatz „{d.get('name')}“ liegt in keinem Raum")
        vals = (
            room_id, s_str(d.get("name"), "Platzname", 60), s_str(d.get("equipment"), "Ausstattung", 300, False),
            0 if d.get("active") in (0, False, "0") else 1, clean_features(d.get("features"), valid_features),
            s_float(d.get("x"), "x"), s_float(d.get("y"), "y"),
        )
        did = d.get("id")
        if isinstance(did, int) and did in existing_desks:
            c.db.execute("UPDATE desks SET room_id=?, name=?, equipment=?, active=?, features=?, x=?, y=? WHERE id=?", vals + (did,))
            keep_d.add(did)
        else:
            c.db.execute("INSERT INTO desks(room_id, name, equipment, active, features, x, y) VALUES (?,?,?,?,?,?,?)", vals)
    for did in existing_desks - keep_d:
        c.db.execute("DELETE FROM desks WHERE id = ?", (did,))
    return load_floor(c.db, fid, c.user)


# ---- Ausstattungsmerkmale ---------------------------------------------------------

@route("GET", "/api/features")
def api_features(c):
    return [dict(r) for r in c.db.execute("SELECT * FROM features ORDER BY sort, name COLLATE NOCASE")]


def _feature_vals(b):
    scope = b.get("scope", "both")
    if scope not in FEATURE_SCOPES:
        raise ApiError(400, "Ungültiger Geltungsbereich")
    return s_str(b.get("name"), "Name", 60), scope, s_int(b.get("sort"), "Sortierung", -9999, 9999, 0)


@route("POST", "/api/features", auth="admin")
def api_feature_create(c):
    cur = c.db.execute("INSERT INTO features(name, scope, sort) VALUES (?,?,?)", _feature_vals(c.body))
    return {"id": cur.lastrowid}


@route("PUT", r"/api/features/(\d+)", auth="admin")
def api_feature_update(c, fid):
    if not c.db.execute("UPDATE features SET name=?, scope=?, sort=? WHERE id=?", _feature_vals(c.body) + (int(fid),)).rowcount:
        raise ApiError(404, "Merkmal nicht gefunden")
    return {"ok": True}


@route("DELETE", r"/api/features/(\d+)", auth="admin")
def api_feature_delete(c, fid):
    fid = int(fid)
    c.db.execute("DELETE FROM features WHERE id = ?", (fid,))
    for table in ("rooms", "desks"):
        for r in c.db.execute(f"SELECT id, features FROM {table} WHERE features <> '[]'").fetchall():
            ids = with_features(r)["features"]
            if fid in ids:
                c.db.execute(f"UPDATE {table} SET features = ? WHERE id = ?", (json.dumps([x for x in ids if x != fid]), r["id"]))
    return {"ok": True}


# ---- Auswertungen (nur nach Räumen/Plätzen, nie nach Personen) ----------------------

MONTHS_DE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"]
WEEKDAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


def _bucket(d, gran):
    """Schlüssel und Beschriftung des Zeitabschnitts, in den ein Tag fällt."""
    if gran == "day":
        return d.isoformat(), f"{WEEKDAYS_DE[d.weekday()]} {d.day:02d}.{d.month:02d}."
    if gran == "week":
        y, w, _ = d.isocalendar()
        return f"{y}-W{w:02d}", f"KW {w}/{y}"
    if gran == "month":
        return f"{d.year}-{d.month:02d}", f"{MONTHS_DE[d.month - 1]} {d.year}"
    return str(d.year), str(d.year)


def _mins(t):
    h, m = t.split(":")
    return int(h) * 60 + int(m)


@route("GET", "/api/stats", auth="admin")
def api_stats(c):
    st = get_settings(c.db)
    d_from, d_to = parse_day(c.q("from")), parse_day(c.q("to"))
    if d_to < d_from:
        raise ApiError(400, "Das Enddatum liegt vor dem Startdatum")
    if (d_to - d_from).days > 3700:
        raise ApiError(400, "Zeitraum ist zu lang (max. 10 Jahre)")
    kind = "room" if c.q("kind") == "room" else "desk"
    gran = c.q("gran") if c.q("gran") in ("day", "week", "month", "year") else "day"
    weekends = c.q("weekends") == "1"
    # Grundlage: "booked" = gebuchte Zeit, "used" = tatsächlich genutzte Zeit laut Check-in/Check-out
    basis = "used" if c.q("basis") == "used" else "booked"
    bid, fid, rid, res_id = (opt_int(c.q(k)) for k in ("building", "floor", "room", "resource"))
    want = {int(x) for x in (c.q("features") or "").split(",") if x.strip().isdigit()}

    # --- Ressourcen (Plätze bzw. Besprechungsräume) ermitteln
    if kind == "desk":
        sql = ("SELECT d.id, d.name, d.features, d.active, r.features AS room_features, r.id AS room_id, r.name AS room_name, "
               "f.id AS floor_id, f.name AS floor_name, b.id AS building_id, b.name AS building_name "
               "FROM desks d JOIN rooms r ON r.id = d.room_id JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = f.building_id WHERE 1=1")
        idcol = "d.id"
    else:
        sql = ("SELECT r.id, r.name, r.features, 1 AS active, '[]' AS room_features, r.id AS room_id, r.name AS room_name, r.capacity, "
               "f.id AS floor_id, f.name AS floor_name, b.id AS building_id, b.name AS building_name "
               "FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = f.building_id WHERE r.kind = 'meeting'")
        idcol = "r.id"
    args = []
    for val, col in ((bid, "b.id"), (fid, "f.id"), (rid, "r.id"), (res_id, idcol)):
        if val is not None:
            sql += f" AND {col} = ?"
            args.append(val)
    resources = {}
    for r in c.db.execute(sql + " ORDER BY b.sort, b.name, f.sort, f.name, r.name, " + ("d.name" if kind == "desk" else "r.name"), args):
        feats = set(with_features(r)["features"]) | set(with_features({"features": r["room_features"]})["features"])
        if want and not want <= feats:
            continue
        o = {k: r[k] for k in ("id", "name", "active", "room_id", "room_name", "floor_id", "floor_name", "building_id", "building_name")}
        o["features"] = sorted(feats)
        o["capacity"] = r["capacity"] if kind == "room" else None
        resources[r["id"]] = o

    # --- Kalender: gezählte Tage und Zeitabschnitte
    open_s, open_e = _mins(st["day_start"]), _mins(st["day_end"])
    open_len = max(1, open_e - open_s)
    hcap = [max(0, min(open_e, (h + 1) * 60) - max(open_s, h * 60)) for h in range(24)]
    # Feiertage/Schließtage zählen nicht als buchbare Tage (alle Gebäude bzw. das ausgewertete Gebäude)
    bset = {o["building_id"] for o in resources.values()} or {bid}

    def is_closed(ds):
        return all(closure_on(c.db, b_, ds) for b_ in bset)
    days, wd_days, buckets = [], [0] * 7, {}
    closed_count = 0
    d = d_from
    while d <= d_to:
        if (weekends or d.weekday() < 5) and is_closed(d.isoformat()):
            closed_count += 1
        elif weekends or d.weekday() < 5:
            days.append(d)
            wd_days[d.weekday()] += 1
            key, label = _bucket(d, gran)
            b = buckets.setdefault(key, {"key": key, "label": label, "days": 0, "minutes": 0, "peak": 0})
            b["days"] += 1
        d += timedelta(days=1)
    n_days, n_res = len(days), len(resources)
    day_set = {x.isoformat() for x in days}

    # --- Buchungen (aktuelle + anonymisiertes Archiv) aufsummieren
    col = "desk_id" if kind == "desk" else "room_id"
    rows = c.db.execute(
        f"SELECT {col} AS rid, day, start, end, checkin, orig_end, attendees FROM bookings WHERE {col} IS NOT NULL AND day BETWEEN ? AND ? "
        f"UNION ALL SELECT {col}, day, start, end, checkin, orig_end, attendees FROM usage_archive WHERE {col} IS NOT NULL AND day BETWEEN ? AND ?",
        (d_from.isoformat(), d_to.isoformat()) * 2,
    ).fetchall()
    # Check-in-Kennzahlen erst ab dem Tag, an dem der Check-in erstmals genutzt wurde (sonst wäre alles „nicht erschienen“)
    first_ci = c.db.execute(
        f"SELECT MIN(day) FROM (SELECT day FROM bookings WHERE checkin IS NOT NULL AND {col} IS NOT NULL "
        f"UNION ALL SELECT day FROM usage_archive WHERE checkin IS NOT NULL AND {col} IS NOT NULL)"
    ).fetchone()[0]
    today_iso, now = date.today().isoformat(), datetime.now().strftime("%H:%M")
    qual = {"past": 0, "checked_in": 0, "noshow": 0, "noshow_min": 0, "released": 0, "released_min": 0}
    att = {"n": 0, "sum": 0, "ratio_sum": 0.0, "ratio_n": 0, "dist": [0] * 6}  # Teilnehmerzahlen (nur Räume)
    att_res = {i: [0, 0, 0.0, 0] for i in resources}  # Anzahl, Summe, Summe Quote, Anzahl Quote
    per_res = {i: {"minutes": 0, "bookings": 0, "days": set(), "hours": [0] * 24, "buckets": {}} for i in resources}
    by_hour, by_wd = [0] * 24, [0] * 7
    heat = [[0] * 24 for _ in range(7)]
    slots = {}  # Tag -> Differenz-Array in 15-Minuten-Schritten (für gleichzeitige Belegung)
    total_min = total_bookings = 0
    for r in rows:
        if r["rid"] not in resources or r["day"] not in day_set:
            continue
        past = r["day"] < today_iso or (r["day"] == today_iso and r["end"] <= now)
        if first_ci and past and r["day"] >= first_ci:
            qual["past"] += 1
            if r["checkin"]:
                qual["checked_in"] += 1
            else:
                qual["noshow"] += 1
                qual["noshow_min"] += max(0, min(open_e, _mins(r["end"])) - max(open_s, _mins(r["start"])))
        if r["orig_end"]:
            qual["released"] += 1
            qual["released_min"] += max(0, _mins(r["orig_end"]) - _mins(r["end"]))
        if kind == "room" and r["attendees"]:
            n_att, cap = r["attendees"], resources[r["rid"]]["capacity"]
            att["n"] += 1
            att["sum"] += n_att
            att["dist"][0 if n_att <= 1 else 1 if n_att == 2 else 2 if n_att <= 4 else 3 if n_att <= 6 else 4 if n_att <= 10 else 5] += 1
            ar = att_res[r["rid"]]
            ar[0] += 1
            ar[1] += n_att
            if cap:
                att["ratio_sum"] += min(1.0, n_att / cap)
                att["ratio_n"] += 1
                ar[2] += min(1.0, n_att / cap)
                ar[3] += 1
        start_t, end_t = r["start"], r["end"]
        if basis == "used":
            if not r["checkin"]:
                continue
            start_t = max(start_t, r["checkin"])
            if r["day"] == today_iso and not past:
                end_t = min(end_t, now)  # laufende Nutzung nur bis jetzt
        s_m, e_m = max(open_s, _mins(start_t)), min(open_e, _mins(end_t))
        if e_m <= s_m:
            continue
        day = date.fromisoformat(r["day"])
        wd = day.weekday()
        key = _bucket(day, gran)[0]
        pr = per_res[r["rid"]]
        dur = e_m - s_m
        pr["minutes"] += dur
        pr["bookings"] += 1
        pr["days"].add(r["day"])
        pr["buckets"][key] = pr["buckets"].get(key, 0) + dur
        buckets[key]["minutes"] += dur
        by_wd[wd] += dur
        total_min += dur
        total_bookings += 1
        for h in range(s_m // 60, (e_m - 1) // 60 + 1):
            ov = min(e_m, (h + 1) * 60) - max(s_m, h * 60)
            if ov > 0:
                by_hour[h] += ov
                heat[wd][h] += ov
                pr["hours"][h] += ov
        arr = slots.setdefault(r["day"], [0] * 97)
        arr[s_m // 15] += 1
        arr[-(-e_m // 15)] -= 1

    # --- gleichzeitige Spitzenbelegung
    peak = {"value": 0, "day": None, "time": None}
    daily_peaks = []
    for day_iso, arr in slots.items():
        cur = best = best_slot = 0
        for i in range(96):
            cur += arr[i]
            if cur > best:
                best, best_slot = cur, i
        daily_peaks.append(best)
        key = _bucket(date.fromisoformat(day_iso), gran)[0]
        buckets[key]["peak"] = max(buckets[key]["peak"], best)
        if best > peak["value"]:
            peak = {"value": best, "day": day_iso, "time": f"{best_slot // 4:02d}:{best_slot % 4 * 15:02d}"}

    # --- Verteilung: wie viele Ressourcen waren gleichzeitig belegt (Anteil der buchbaren Zeit)
    open_slots = [i for i in range(96) if i * 15 >= open_s and (i + 1) * 15 <= open_e]
    dist = [0] * (n_res + 1)
    for day_iso in day_set:
        arr = slots.get(day_iso)
        if not arr:
            dist[0] += len(open_slots)
            continue
        level, cur = [0] * 96, 0
        for i in range(96):
            cur += arr[i]
            level[i] = cur
        for i in open_slots:
            dist[max(0, min(n_res, level[i]))] += 1
    total_slots = sum(dist)

    def ratio(a, b):
        return round(a / b, 4) if b else 0

    def hours(m):
        return round(m / 60, 1)

    hour_rows = [{"hour": h, "hours": hours(by_hour[h]), "util": ratio(by_hour[h], n_res * hcap[h] * n_days)}
                 for h in range(24) if hcap[h]]
    wd_rows = [{"wd": i, "label": WEEKDAYS_DE[i], "hours": hours(by_wd[i]), "util": ratio(by_wd[i], n_res * open_len * wd_days[i])}
               for i in range(7) if wd_days[i]]
    heat_rows = [{"wd": i, "label": WEEKDAYS_DE[i],
                  "cells": [{"hour": h, "hours": hours(heat[i][h]), "util": ratio(heat[i][h], n_res * hcap[h] * wd_days[i])}
                            for h in range(24) if hcap[h]]}
                 for i in range(7) if wd_days[i]]
    slots_rank = sorted((c2 | {"wd": row["label"]} for row in heat_rows for c2 in row["cells"]), key=lambda x: x["util"])
    series = [{"key": b["key"], "label": b["label"], "days": b["days"], "hours": hours(b["minutes"]), "peak": b["peak"],
               "util": ratio(b["minutes"], n_res * open_len * b["days"])} for b in buckets.values()]
    res_out = []
    for i, o in resources.items():
        pr = per_res[i]
        top_h = max(range(24), key=lambda h: pr["hours"][h]) if pr["minutes"] else None
        res_out.append(o | {
            "hours": hours(pr["minutes"]), "bookings": pr["bookings"], "days_used": len(pr["days"]),
            "util": ratio(pr["minutes"], open_len * n_days), "avg_hours_per_day": round(pr["minutes"] / 60 / n_days, 2) if n_days else 0,
            "peak_hour": top_h, "buckets": {k: hours(v) for k, v in pr["buckets"].items()},
            "att_count": att_res[i][0], "avg_attendees": round(att_res[i][1] / att_res[i][0], 1) if att_res[i][0] else None,
            "seat_util": round(att_res[i][2] / att_res[i][3], 3) if att_res[i][3] else None,
        })
    return {
        "from": d_from.isoformat(), "to": d_to.isoformat(), "kind": kind, "gran": gran, "weekends": weekends,
        "day_start": st["day_start"], "day_end": st["day_end"], "open_hours": round(open_len / 60, 2),
        "totals": {
            "resources": n_res, "days": n_days, "hours": hours(total_min), "bookings": total_bookings,
            "capacity_hours": hours(n_res * open_len * n_days), "util": ratio(total_min, n_res * open_len * n_days),
            "used_resources": sum(1 for x in res_out if x["bookings"]), "peak": peak,
            "avg_daily_peak": round(sum(daily_peaks) / n_days, 1) if n_days else 0,
            "full_share": ratio(dist[n_res], total_slots) if n_res else 0,
            "full_hours": hours(dist[n_res] * 15) if n_res else 0,
        },
        "basis": basis,
        "closed_days": closed_count,
        "attendees": {
            "count": att["n"], "avg": round(att["sum"] / att["n"], 1) if att["n"] else None,
            "seat_util": round(att["ratio_sum"] / att["ratio_n"], 3) if att["ratio_n"] else None,
            "dist": [{"label": l, "count": n, "share": ratio(n, att["n"])}
                     for l, n in zip(("1", "2", "3–4", "5–6", "7–10", "11+"), att["dist"])],
        } if kind == "room" else None,
        "checkin": {
            "since": first_ci, "past": qual["past"], "checked_in": qual["checked_in"], "rate": ratio(qual["checked_in"], qual["past"]),
            "noshow": qual["noshow"], "noshow_hours": hours(qual["noshow_min"]),
            "released": qual["released"], "released_hours": hours(qual["released_min"]),
        },
        "concurrency": [{"k": k, "hours": hours(dist[k] * 15), "share": ratio(dist[k], total_slots)} for k in range(n_res + 1)],
        "by_hour": hour_rows, "by_weekday": wd_rows, "heat": heat_rows, "series": series,
        "busiest": [x for x in reversed(slots_rank[-5:]) if x["util"] > 0],
        "quietest": slots_rank[:5],
        "resources": res_out,
    }


# ---- Buchungen --------------------------------------------------------------------

def booking_out(c, r):
    mine = r["user_id"] == c.user["id"]
    o = {k: r[k] for k in ("id", "desk_id", "room_id", "day", "start", "end", "desk_name", "room_name",
                           "floor_id", "floor_name", "building_id", "building_name", "show_name", "checkin", "checkout", "orig_end",
                           "attendees")}
    o["mine"] = mine
    # Name nur, wenn die Person es bei der Buchung ausdrücklich erlaubt hat (Admins sehen ihn zur Verwaltung)
    o["user_name"] = r["user_name"] if (mine or r["show_name"] or c.is_admin) else None
    o["note"] = r["note"] if (mine or c.is_admin) else ""
    if c.is_admin:
        o["user_id"] = r["user_id"]
        o["username"] = r["username"]
        o["created"] = r["created"]
    return o


@route("GET", r"/api/floors/(\d+)/bookings")
def api_floor_bookings(c, fid):
    if c.q("from"):
        d_from, d_to = parse_day(c.q("from")), parse_day(c.q("to"))
        if d_to < d_from or (d_to - d_from).days > 31:
            raise ApiError(400, "Ungültiger Zeitraum (max. 31 Tage)")
    else:
        d_from = d_to = parse_day(c.q("date"))
    rows = c.db.execute(BOOKING_SELECT + " WHERE b.day BETWEEN ? AND ? AND f.id = ? ORDER BY b.day, b.start",
                        (d_from.isoformat(), d_to.isoformat(), int(fid))).fetchall()
    return [booking_out(c, r) for r in rows]


@route("GET", "/api/bookings/mine")
def api_bookings_mine(c):
    since = (date.today() - timedelta(days=30 if c.q("past") else 0)).isoformat()
    rows = c.db.execute(BOOKING_SELECT + " WHERE b.user_id = ? AND b.day >= ? ORDER BY b.day, b.start", (c.user["id"], since)).fetchall()
    return [booking_out(c, r) for r in rows]


@route("GET", "/api/bookings", auth="admin")
def api_bookings_all(c):
    d_from = parse_day(c.q("from", date.today().isoformat()))
    d_to = parse_day(c.q("to", (date.today() + timedelta(days=30)).isoformat()))
    rows = c.db.execute(
        BOOKING_SELECT + " WHERE b.day BETWEEN ? AND ? ORDER BY b.day, b.start, bl.name, f.name", (d_from.isoformat(), d_to.isoformat())
    ).fetchall()
    return [booking_out(c, r) for r in rows]


def resource_info(c, desk_id, room_id):
    """Prüft Platz bzw. Raum; liefert (building_id, Kapazität des Raums oder None)."""
    if (desk_id is None) == (room_id is None):
        raise ApiError(400, "Bitte genau einen Arbeitsplatz oder Raum wählen")
    if desk_id is not None:
        d = c.db.execute("SELECT d.active, d.room_id, f.building_id FROM desks d JOIN rooms r ON r.id = d.room_id "
                         "JOIN floors f ON f.id = r.floor_id WHERE d.id = ?", (desk_id,)).fetchone()
        if not d:
            raise ApiError(404, "Arbeitsplatz nicht gefunden")
        if not d["active"]:
            raise ApiError(400, "Dieser Arbeitsplatz ist gesperrt")
        check_access(c, d["room_id"])
        return d["building_id"], None
    r = c.db.execute("SELECT r.kind, r.capacity, f.building_id FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = ?",
                     (room_id,)).fetchone()
    if not r:
        raise ApiError(404, "Raum nicht gefunden")
    if r["kind"] != "meeting":
        raise ApiError(400, "Dieser Raum ist nicht als Ganzes buchbar")
    check_access(c, room_id)
    return r["building_id"], r["capacity"]


def booking_params(c, b, st):
    """Gemeinsame Angaben einer Buchung (Zeit, Person, Notiz, Namensanzeige)."""
    start = parse_time(b.get("start"), "Startzeit")
    end = parse_time(b.get("end"), "Endzeit")
    if start >= end:
        raise ApiError(400, "Die Startzeit muss vor der Endzeit liegen")
    if start < st["day_start"] or end > st["day_end"]:
        raise ApiError(400, f"Buchungen sind nur zwischen {st['day_start']} und {st['day_end']} Uhr möglich")
    uid = c.user["id"]
    if c.is_admin and b.get("user_id"):
        uid = opt_int(b.get("user_id"))
        if not c.db.execute("SELECT 1 FROM users WHERE id = ? AND active = 1", (uid,)).fetchone():
            raise ApiError(404, "Benutzer nicht gefunden oder inaktiv")
    return {"start": start, "end": end, "uid": uid, "note": s_str(b.get("note"), "Notiz", 300, False),
            "show_name": 1 if b.get("show_name") in (True, 1, "1") else 0}


def parse_attendees(b, room_id, capacity):
    if room_id is None:
        return None
    n = s_int(b.get("attendees"), "Teilnehmerzahl", 1, 999)
    if capacity and n > capacity:
        raise ApiError(400, f"Der Raum bietet nur {capacity} Plätze")
    return n


@functools.lru_cache(maxsize=256)
def holiday_map(year, state):
    return {d.isoformat(): n for d, n in german_holidays(year, state)}


def building_state(db, building_id):
    """Bundesland eines Gebäudes; ohne eigene Angabe gilt das Standard-Bundesland aus den Einstellungen."""
    if building_id is not None:
        r = db.execute("SELECT state FROM buildings WHERE id = ?", (building_id,)).fetchone()
        if r and r["state"]:
            return r["state"]
    r = db.execute("SELECT value FROM settings WHERE key = 'holiday_state'").fetchone()
    return r["value"] if r else ""


def closure_on(db, building_id, ds):
    """Ist der Tag geschlossen? Reihenfolge: manueller Schließtag/Feiertag > manuelle Ausnahme > gesetzlicher Feiertag."""
    rows = db.execute("SELECT name, kind FROM closures WHERE day = ? AND (building_id IS NULL OR building_id = ?)",
                      (ds, building_id)).fetchall()
    for r in rows:
        if r["kind"] in ("closed", "holiday"):
            return {"name": r["name"], "kind": r["kind"], "auto": False}
    if any(r["kind"] == "open" for r in rows):
        return None
    state = building_state(db, building_id)
    if state in GERMAN_STATES:
        name = holiday_map(int(ds[:4]), state).get(ds)
        if name:
            return {"name": name, "kind": "holiday", "auto": True}
    return None


def book_one(c, st, p, desk_id, room_id, building_id, day, attendees):
    """Legt eine Buchung an oder liefert den Grund, warum es nicht geht."""
    ds, today = day.isoformat(), date.today()
    start, end = p["start"], p["end"]
    if day < today or (day == today and end <= datetime.now().strftime("%H:%M")):
        return "liegt in der Vergangenheit"
    if day > today + timedelta(days=int(st["max_days_ahead"])) and not c.is_admin:
        return f"nur {st['max_days_ahead']} Tage im Voraus buchbar"
    cl = closure_on(c.db, building_id, ds)
    if cl:
        return ("Feiertag: " if cl["kind"] == "holiday" else "geschlossen: ") + cl["name"]
    if c.db.execute("SELECT 1 FROM bookings WHERE day = ? AND start < ? AND end > ? AND " + ("desk_id = ?" if desk_id else "room_id = ?"),
                    (ds, end, start, desk_id or room_id)).fetchone():
        return "bereits belegt"
    if desk_id and st["one_desk_per_user"] == "1" and c.db.execute(
            "SELECT 1 FROM bookings WHERE day = ? AND user_id = ? AND desk_id IS NOT NULL AND start < ? AND end > ?",
            (ds, p["uid"], end, start)).fetchone():
        return "in diesem Zeitraum ist bereits ein Arbeitsplatz gebucht"
    c.db.execute(
        "INSERT INTO bookings(user_id, desk_id, room_id, day, start, end, note, created, show_name, attendees) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (p["uid"], desk_id, room_id, ds, start, end, p["note"], now_iso(), p["show_name"], attendees))
    return None


def booking_result(created, skipped):
    if not created:
        raise ApiError(409, "Buchung nicht möglich: " + skipped[0]["reason"] if len(skipped) == 1
                       else "Keine Buchung möglich – alle gewählten Tage sind belegt oder nicht buchbar")
    return {"created": created, "skipped": skipped}


@route("POST", "/api/bookings")
def api_booking_create(c):
    b = c.body
    st = get_settings(c.db)
    desk_id, room_id = opt_int(b.get("desk_id")), opt_int(b.get("room_id"))
    building_id, capacity = resource_info(c, desk_id, room_id)
    p = booking_params(c, b, st)
    attendees = parse_attendees(b, room_id, capacity)
    first = parse_day(b.get("date"))
    until = parse_day(b["until"]) if b.get("until") else first
    if until < first:
        raise ApiError(400, "Das Enddatum der Serie liegt vor dem Startdatum")
    if until != first and st["allow_series"] != "1" and not c.is_admin:
        raise ApiError(403, "Serienbuchungen sind deaktiviert")
    if (until - first).days > 92:
        raise ApiError(400, "Serienbuchungen sind auf maximal 3 Monate begrenzt")
    days = [first + timedelta(days=i) for i in range((until - first).days + 1)]
    if until != first:
        days = [x for x in days if x.weekday() < 5]  # nur Werktage
    created, skipped = [], []
    with WRITE_LOCK:
        for day in days:
            reason = book_one(c, st, p, desk_id, room_id, building_id, day, attendees)
            if reason:
                skipped.append({"date": day.isoformat(), "reason": reason})
            else:
                created.append(day.isoformat())
        c.db.commit()
    return booking_result(created, skipped)


@route("POST", "/api/bookings/batch")
def api_booking_batch(c):
    """Mehrere Plätze/Räume an beliebigen Tagen in einem Schritt (Wochenansicht)."""
    b = c.body
    st = get_settings(c.db)
    items = b.get("items")
    if not isinstance(items, list) or not items:
        raise ApiError(400, "Keine Auswahl übergeben")
    if len(items) > 100:
        raise ApiError(400, "Höchstens 100 Buchungen auf einmal")
    p = booking_params(c, b, st)
    created, skipped = [], []
    with WRITE_LOCK:
        for it in items:
            if not isinstance(it, dict):
                raise ApiError(400, "Ungültige Auswahl")
            desk_id, room_id = opt_int(it.get("desk_id")), opt_int(it.get("room_id"))
            day = parse_day(it.get("date"))
            ref = {"date": day.isoformat(), "desk_id": desk_id, "room_id": room_id}
            try:
                building_id, capacity = resource_info(c, desk_id, room_id)
                attendees = parse_attendees(b, room_id, capacity)
            except ApiError as e:
                skipped.append(ref | {"reason": e.message})
                continue
            reason = book_one(c, st, p, desk_id, room_id, building_id, day, attendees)
            if reason:
                skipped.append(ref | {"reason": reason})
            else:
                created.append(ref)
        c.db.commit()
    return booking_result(created, skipped)


# ---- Favoriten & Vorschläge ------------------------------------------------------

FAVORITE_SELECT = """
SELECT fa.id, fa.desk_id, fa.room_id, d.name AS desk_name, d.active AS desk_active, COALESCE(r1.name, r2.name) AS room_name,
       COALESCE(r1.id, r2.id) AS acc_room_id,
       r2.capacity AS capacity, f.id AS floor_id, f.name AS floor_name, bl.id AS building_id, bl.name AS building_name
FROM favorites fa
LEFT JOIN desks d ON d.id = fa.desk_id
LEFT JOIN rooms r1 ON r1.id = d.room_id
LEFT JOIN rooms r2 ON r2.id = fa.room_id
JOIN floors f ON f.id = COALESCE(r1.floor_id, r2.floor_id)
JOIN buildings bl ON bl.id = f.building_id
"""


@route("GET", "/api/favorites")
def api_favorites(c):
    rows = [dict(r) for r in c.db.execute(FAVORITE_SELECT + " WHERE fa.user_id = ? ORDER BY bl.sort, bl.name, f.sort, f.name, fa.id",
                                          (c.user["id"],))]
    if c.q("date"):
        ds = parse_day(c.q("date")).isoformat()
        start, end = parse_time(c.q("start"), "Startzeit"), parse_time(c.q("end"), "Endzeit")
        mine = user_groups(c.db, c.user["id"])
        for f in rows:
            col, rid = ("desk_id", f["desk_id"]) if f["desk_id"] else ("room_id", f["room_id"])
            cl = closure_on(c.db, f["building_id"], ds)
            bk = c.db.execute(f"SELECT user_id FROM bookings WHERE day = ? AND {col} = ? AND start < ? AND end > ?",
                              (ds, rid, end, start)).fetchall()
            f["status"] = ("closed" if cl else "off" if f["desk_id"] and not f["desk_active"]
                           else "denied" if not may_book(c.user, mine, room_access(c.db, f["acc_room_id"]))
                           else "mine" if any(x["user_id"] == c.user["id"] for x in bk) else "busy" if bk else "free")
            f["closure"] = cl["name"] if cl else None
    return rows


@route("POST", "/api/favorites")
def api_favorite_add(c):
    desk_id, room_id = opt_int(c.body.get("desk_id")), opt_int(c.body.get("room_id"))
    resource_info(c, desk_id, room_id)
    col, rid = ("desk_id", desk_id) if desk_id else ("room_id", room_id)
    ex = c.db.execute(f"SELECT id FROM favorites WHERE user_id = ? AND {col} = ?", (c.user["id"], rid)).fetchone()
    if ex:
        return {"id": ex["id"]}
    if c.db.execute("SELECT COUNT(*) FROM favorites WHERE user_id = ?", (c.user["id"],)).fetchone()[0] >= 30:
        raise ApiError(400, "Höchstens 30 Favoriten")
    cur = c.db.execute("INSERT INTO favorites(user_id, desk_id, room_id, created) VALUES (?,?,?,?)", (c.user["id"], desk_id, room_id, now_iso()))
    return {"id": cur.lastrowid}


@route("DELETE", r"/api/favorites/(\d+)")
def api_favorite_delete(c, fid):
    c.db.execute("DELETE FROM favorites WHERE id = ? AND user_id = ?", (int(fid), c.user["id"]))
    return {"ok": True}


@route("GET", "/api/suggest")
def api_suggest(c):
    """Schlägt freie Arbeitsplätze vor: Favoriten zuerst, dann häufig genutzte, passend zur Ausstattung."""
    st = get_settings(c.db)
    day = parse_day(c.q("date"))
    ds = day.isoformat()
    start, end = parse_time(c.q("start"), "Startzeit"), parse_time(c.q("end"), "Endzeit")
    want = {int(x) for x in (c.q("features") or "").split(",") if x.strip().isdigit()}
    bid, fid = opt_int(c.q("building")), opt_int(c.q("floor"))
    uid = c.user["id"]
    if st["one_desk_per_user"] == "1" and c.db.execute(
            "SELECT 1 FROM bookings WHERE day = ? AND user_id = ? AND desk_id IS NOT NULL AND start < ? AND end > ?", (ds, uid, end, start)).fetchone():
        return {"items": [], "info": "Sie haben in diesem Zeitraum bereits einen Arbeitsplatz gebucht."}
    sql = ("SELECT d.id, d.name, d.features, r.features AS room_features, r.name AS room_name, f.id AS floor_id, f.name AS floor_name, "
           "bl.id AS building_id, bl.name AS building_name, bl.sort AS bsort, f.sort AS fsort, "
           "r.access AS ra, f.access AS fa, bl.access AS ba "
           "FROM desks d JOIN rooms r ON r.id = d.room_id JOIN floors f ON f.id = r.floor_id JOIN buildings bl ON bl.id = f.building_id "
           "WHERE d.active = 1 AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.desk_id = d.id AND b.day = ? AND b.start < ? AND b.end > ?)")
    args = [ds, end, start]
    if bid:
        sql += " AND bl.id = ?"
        args.append(bid)
    favs = {r[0] for r in c.db.execute("SELECT desk_id FROM favorites WHERE user_id = ? AND desk_id IS NOT NULL", (uid,))}
    used = {r[0]: r[1] for r in c.db.execute(
        "SELECT desk_id, COUNT(*) FROM bookings WHERE user_id = ? AND desk_id IS NOT NULL AND day >= ? GROUP BY desk_id",
        (uid, (date.today() - timedelta(days=180)).isoformat()))}
    out = []
    mine = user_groups(c.db, uid)
    for r in c.db.execute(sql, args):
        if not may_book(c.user, mine, effective_access(r["ra"], r["fa"], r["ba"])[0]):
            continue
        feats = set(with_features(r)["features"]) | set(with_features({"features": r["room_features"]})["features"])
        if want and not want <= feats:
            continue
        if closure_on(c.db, r["building_id"], ds):
            continue
        why = []
        if r["id"] in favs:
            why.append("Favorit")
        if used.get(r["id"]):
            why.append(f"{used[r['id']]}× von Ihnen gebucht")
        if want:
            why.append("passende Ausstattung")
        if fid and r["floor_id"] == fid:
            why.append("auf der gewählten Etage")
        score = (r["id"] in favs, used.get(r["id"], 0), fid == r["floor_id"])
        out.append((score, (r["bsort"], r["building_name"], r["fsort"], r["floor_name"], r["room_name"]), r, sorted(feats), why))
    out.sort(key=lambda x: (tuple(-int(v) for v in x[0]), x[1]))
    limit = s_int(c.q("limit"), "Anzahl", 1, 20, 5)
    return {"items": [{"desk_id": r["id"], "desk_name": r["name"], "room_name": r["room_name"], "floor_id": r["floor_id"],
                       "floor_name": r["floor_name"], "building_id": r["building_id"], "building_name": r["building_name"],
                       "features": feats, "why": why} for _, _, r, feats, why in out[:limit]], "total_free": len(out)}


# ---- Nicht erfüllter Bedarf -----------------------------------------------------------

DEMAND_KINDS = {"desk": "Arbeitsplatz", "room": "Besprechungsraum"}


@route("POST", "/api/demand")
def api_demand_create(c):
    """„Nichts Passendes gefunden“ melden. Gespeichert wird nur WAS gebraucht wurde – nicht WER es gemeldet hat."""
    b = c.body
    kind = b.get("kind")
    if kind not in DEMAND_KINDS:
        raise ApiError(400, "Bitte angeben: Arbeitsplatz oder Besprechungsraum")
    day = parse_day(b.get("date")).isoformat()
    start, end = parse_time(b.get("start"), "Startzeit"), parse_time(b.get("end"), "Endzeit")
    if start >= end:
        raise ApiError(400, "Die Startzeit muss vor der Endzeit liegen")
    bid = opt_int(b.get("building_id"))
    if bid and not c.db.execute("SELECT 1 FROM buildings WHERE id = ?", (bid,)).fetchone():
        raise ApiError(400, "Unbekanntes Gebäude")
    att = None
    if kind == "room" and b.get("attendees") not in (None, ""):
        att = s_int(b.get("attendees"), "Teilnehmerzahl", 1, 500)
    valid = {r["id"]: r["name"] for r in c.db.execute("SELECT id, name FROM features WHERE scope IN (?, 'both')", (kind,))}
    feats = [valid[i] for i in json.loads(clean_features(b.get("features") or [], set(valid)))]
    note = s_str(b.get("note"), "Bemerkung", 500, required=False)
    c.db.execute("INSERT INTO demand(created, day, start, end, kind, building_id, attendees, features, note) VALUES (?,?,?,?,?,?,?,?,?)",
                 (now_iso(), day, start, end, kind, bid, att, json.dumps(feats, ensure_ascii=False), note))
    return {"ok": True}


@route("GET", "/api/demand", auth="admin")
def api_demand(c):
    frm, to = parse_day(c.q("from")).isoformat(), parse_day(c.q("to")).isoformat()
    sql = ("SELECT d.*, b.name AS building_name FROM demand d LEFT JOIN buildings b ON b.id = d.building_id "
           "WHERE d.day BETWEEN ? AND ?")
    args = [frm, to]
    if c.q("kind") in DEMAND_KINDS:
        sql += " AND d.kind = ?"
        args.append(c.q("kind"))
    bid = opt_int(c.q("building"))
    if bid:
        sql += " AND (d.building_id = ? OR d.building_id IS NULL)"
        args.append(bid)
    items = []
    for r in c.db.execute(sql + " ORDER BY d.day DESC, d.start DESC", args):
        x = dict(r)
        x["features"] = json.loads(x["features"] or "[]")
        items.append(x)
    feat_count, hours, weekdays = {}, [0] * 24, [0] * 7
    for x in items:
        for f in x["features"]:
            feat_count[f] = feat_count.get(f, 0) + 1
        for hh in range(int(x["start"][:2]), int(x["end"][:2]) + (1 if x["end"][3:] != "00" else 0)):
            hours[hh] += 1
        weekdays[date.fromisoformat(x["day"]).weekday()] += 1
    return {"items": items, "count": len(items), "days": len({x["day"] for x in items}),
            "features": sorted(({"name": k, "count": v} for k, v in feat_count.items()), key=lambda f: -f["count"]),
            "by_hour": hours, "by_weekday": weekdays,
            "attendees": [x["attendees"] for x in items if x["attendees"]]}


@route("DELETE", r"/api/demand/(\d+)", auth="admin")
def api_demand_delete(c, did):
    c.db.execute("DELETE FROM demand WHERE id = ?", (int(did),))
    return {"ok": True}


# ---- Feiertage & Schließtage ------------------------------------------------------

GERMAN_STATES = {
    "BW": "Baden-Württemberg", "BY": "Bayern", "BE": "Berlin", "BB": "Brandenburg", "HB": "Bremen", "HH": "Hamburg",
    "HE": "Hessen", "MV": "Mecklenburg-Vorpommern", "NI": "Niedersachsen", "NW": "Nordrhein-Westfalen",
    "RP": "Rheinland-Pfalz", "SL": "Saarland", "SN": "Sachsen", "ST": "Sachsen-Anhalt", "SH": "Schleswig-Holstein", "TH": "Thüringen",
}


def easter_sunday(y):
    """Ostersonntag (gregorianisch, anonymer Algorithmus)."""
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    return date(y, month, (h + l - 7 * m + 114) % 31 + 1)


def german_holidays(y, state):
    """Gesetzliche Feiertage (bundesweit + Bundesland), vollständig offline berechnet."""
    e = easter_sunday(y)
    h = [(date(y, 1, 1), "Neujahr"), (e - timedelta(days=2), "Karfreitag"), (e + timedelta(days=1), "Ostermontag"),
         (date(y, 5, 1), "Tag der Arbeit"), (e + timedelta(days=39), "Christi Himmelfahrt"), (e + timedelta(days=50), "Pfingstmontag"),
         (date(y, 10, 3), "Tag der Deutschen Einheit"), (date(y, 12, 25), "1. Weihnachtstag"), (date(y, 12, 26), "2. Weihnachtstag")]
    if state in ("BW", "BY", "ST"):
        h.append((date(y, 1, 6), "Heilige Drei Könige"))
    if (state == "BE" and y >= 2019) or (state == "MV" and y >= 2023):
        h.append((date(y, 3, 8), "Internationaler Frauentag"))
    if state == "BE" and y in (2020, 2025):
        h.append((date(y, 5, 8), "Tag der Befreiung"))
    if state in ("BW", "BY", "HE", "NW", "RP", "SL"):
        h.append((e + timedelta(days=60), "Fronleichnam"))
    if state == "SL":
        h.append((date(y, 8, 15), "Mariä Himmelfahrt"))
    if state == "BY":
        h.append((date(y, 8, 15), "Mariä Himmelfahrt (überwiegend kath. Gemeinden)"))
    if state == "TH" and y >= 2019:
        h.append((date(y, 9, 20), "Weltkindertag"))
    if state in ("BB", "MV", "SN", "ST", "TH") or (state in ("HB", "HH", "NI", "SH") and y >= 2018):
        h.append((date(y, 10, 31), "Reformationstag"))
    if state in ("BW", "BY", "NW", "RP", "SL"):
        h.append((date(y, 11, 1), "Allerheiligen"))
    if state == "SN":
        d = date(y, 11, 22)
        while d.weekday() != 2:
            d -= timedelta(days=1)
        h.append((d, "Buß- und Bettag"))
    return sorted(h)


def _closure_building(c, v):
    bid = opt_int(v)
    if bid is not None and not c.db.execute("SELECT 1 FROM buildings WHERE id = ?", (bid,)).fetchone():
        raise ApiError(404, "Gebäude nicht gefunden")
    return bid


def _insert_closure(c, day, name, kind, bid):
    """Fügt einen Tag hinzu, falls für diesen Tag/dieses Gebäude noch nichts eingetragen ist."""
    ds = day.isoformat()
    if c.db.execute("SELECT 1 FROM closures WHERE day = ? AND building_id IS ? AND kind <> 'open'", (ds, bid)).fetchone():
        return False
    c.db.execute("INSERT INTO closures(day, name, kind, building_id) VALUES (?,?,?,?)", (ds, name, kind, bid))
    return True


def _affected_bookings(c, days, bid):
    if not days:
        return 0
    q = ("SELECT COUNT(*) FROM bookings b LEFT JOIN desks d ON d.id = b.desk_id LEFT JOIN rooms r1 ON r1.id = d.room_id "
         "LEFT JOIN rooms r2 ON r2.id = b.room_id JOIN floors f ON f.id = COALESCE(r1.floor_id, r2.floor_id) "
         f"WHERE b.day IN ({','.join('?' * len(days))})")
    args = [d.isoformat() for d in days]
    if bid is not None:
        q += " AND f.building_id = ?"
        args.append(bid)
    return c.db.execute(q, args).fetchone()[0]


@route("GET", "/api/closures")
def api_closures(c):
    """Wirksame geschlossene Tage (gesetzliche Feiertage automatisch + manuelle Einträge) für ein Gebäude."""
    d_from = parse_day(c.q("from", date.today().isoformat()))
    d_to = parse_day(c.q("to", (date.today() + timedelta(days=31)).isoformat()))
    if d_to < d_from or (d_to - d_from).days > 400:
        raise ApiError(400, "Ungültiger Zeitraum")
    bid = opt_int(c.q("building"))
    out, d = [], d_from
    while d <= d_to:
        cl = closure_on(c.db, bid, d.isoformat())
        if cl:
            out.append({"day": d.isoformat(), "building_id": bid} | cl)
        d += timedelta(days=1)
    return out


@route("GET", "/api/closures/manual", auth="admin")
def api_closures_manual(c):
    rows = c.db.execute("SELECT cl.*, b.name AS building_name FROM closures cl LEFT JOIN buildings b ON b.id = cl.building_id "
                        "WHERE cl.day >= ? ORDER BY cl.day", (date(date.today().year, 1, 1).isoformat(),))
    return [dict(r) for r in rows]


@route("GET", "/api/holidays/preview", auth="admin")
def api_holiday_preview(c):
    """Gesetzliche Feiertage der nächsten 12 Monate je verwendetem Bundesland (für die Einstellungen)."""
    default = get_settings(c.db)["holiday_state"]
    groups, without = {}, []
    for b in c.db.execute("SELECT name, state FROM buildings ORDER BY sort, name COLLATE NOCASE"):
        st = b["state"] or default
        if st:
            groups.setdefault(st, []).append(b["name"] + ("" if b["state"] else " (Standard)"))
        else:
            without.append(b["name"])
    if default and default not in groups:
        groups[default] = []
    exc = {r["day"]: r["id"] for r in c.db.execute("SELECT id, day FROM closures WHERE kind = 'open' AND building_id IS NULL")}
    start, end = date.today(), date.today() + timedelta(days=365)
    states = []
    for st, names in groups.items():
        items = sorted((d, n) for y in (start.year, start.year + 1) for d, n in german_holidays(y, st) if start <= d <= end)
        states.append({"state": st, "state_name": GERMAN_STATES[st], "buildings": names,
                       "holidays": [{"day": d.isoformat(), "name": n, "exception_id": exc.get(d.isoformat())} for d, n in items]})
    return {"default_state": default, "states": states, "buildings_without_state": without}


@route("POST", "/api/closures/exception", auth="admin")
def api_closure_exception(c):
    """Einen gesetzlichen Feiertag ausnehmen (an dem Tag wird gearbeitet / Rechtslage geändert)."""
    ds = parse_day(c.body.get("day")).isoformat()
    name = s_str(c.body.get("name"), "Bezeichnung", 100)
    if not c.db.execute("SELECT 1 FROM closures WHERE day = ? AND kind = 'open' AND building_id IS NULL", (ds,)).fetchone():
        c.db.execute("INSERT INTO closures(day, name, kind, building_id) VALUES (?,?,'open',NULL)", (ds, name))
    return {"ok": True}


@route("POST", "/api/closures", auth="admin")
def api_closure_create(c):
    b = c.body
    d_from = parse_day(b.get("from"))
    d_to = parse_day(b.get("to") or b.get("from"))
    if d_to < d_from or (d_to - d_from).days > 366:
        raise ApiError(400, "Ungültiger Zeitraum (max. 1 Jahr)")
    name = s_str(b.get("name"), "Bezeichnung", 100)
    kind = "holiday" if b.get("kind") == "holiday" else "closed"
    bid = _closure_building(c, b.get("building_id"))
    added = []
    for i in range((d_to - d_from).days + 1):
        day = d_from + timedelta(days=i)
        if (b.get("workdays_only", True) and day.weekday() >= 5):
            continue
        if _insert_closure(c, day, name, kind, bid):
            added.append(day)
    return {"created": len(added), "affected_bookings": _affected_bookings(c, added, bid)}


@route("DELETE", r"/api/closures/(\d+)", auth="admin")
def api_closure_delete(c, cid):
    c.db.execute("DELETE FROM closures WHERE id = ?", (int(cid),))
    return {"ok": True}


def own_booking(c, bid):
    r = c.db.execute("SELECT * FROM bookings WHERE id = ?", (int(bid),)).fetchone()
    if not r:
        raise ApiError(404, "Buchung nicht gefunden")
    if not c.is_admin and r["user_id"] != c.user["id"]:
        raise ApiError(403, "Das ist nicht Ihre Buchung")
    return r


def now_hm():
    return datetime.now().strftime("%H:%M")


@route("DELETE", r"/api/bookings/(\d+)")
def api_booking_delete(c, bid):
    r = own_booking(c, bid)
    if not c.is_admin:
        today = date.today().isoformat()
        if r["day"] < today:
            raise ApiError(400, "Vergangene Buchungen können nicht storniert werden")
        if r["day"] == today and r["start"] <= now_hm():
            raise ApiError(400, "Die Buchung läuft bereits. Bitte „Freigeben“ bzw. „Ich bin nicht mehr da“ verwenden – "
                                "so bleibt die genutzte Zeit in der Auswertung erhalten.")
    c.db.execute("DELETE FROM bookings WHERE id = ?", (int(bid),))
    return {"ok": True}


@route("PUT", r"/api/bookings/(\d+)")
def api_booking_update(c, bid):
    own_booking(c, bid)
    if "show_name" in c.body:
        c.db.execute("UPDATE bookings SET show_name = ? WHERE id = ?", (1 if c.body["show_name"] in (True, 1, "1") else 0, int(bid)))
    return {"ok": True}


@route("POST", r"/api/bookings/(\d+)/checkin")
def api_booking_checkin(c, bid):
    r = own_booking(c, bid)
    now = now_hm()
    if r["day"] != date.today().isoformat():
        raise ApiError(400, "Einchecken ist nur am Tag der Buchung möglich")
    if r["checkout"]:
        raise ApiError(400, "Diese Buchung wurde bereits beendet")
    if r["checkin"]:
        raise ApiError(400, f"Sie sind bereits seit {r['checkin']} Uhr eingecheckt")
    early = (datetime.combine(date.today(), datetime.strptime(r["start"], "%H:%M").time()) - timedelta(minutes=CHECKIN_EARLY_MIN)).strftime("%H:%M")
    if now < early:
        raise ApiError(400, f"Einchecken ist ab {early} Uhr möglich")
    if now >= r["end"]:
        raise ApiError(400, "Die Buchungszeit ist bereits abgelaufen")
    c.db.execute("UPDATE bookings SET checkin = ? WHERE id = ?", (now, int(bid)))
    return {"ok": True, "checkin": now}


@route("POST", r"/api/bookings/(\d+)/checkout")
def api_booking_checkout(c, bid):
    """„Ich bin nicht mehr da“ bzw. „Freigeben“: Buchung endet jetzt, Restzeit wird für andere frei."""
    r = own_booking(c, bid)
    now = now_hm()
    if r["day"] != date.today().isoformat():
        raise ApiError(400, "Nur für heutige Buchungen möglich")
    if r["checkout"] or now >= r["end"]:
        raise ApiError(400, "Diese Buchung ist bereits beendet")
    if now <= r["start"]:
        raise ApiError(400, "Die Buchung hat noch nicht begonnen – bitte stattdessen stornieren")
    c.db.execute("UPDATE bookings SET orig_end = COALESCE(orig_end, end), end = ?, checkout = ? WHERE id = ?", (now, now, int(bid)))
    return {"ok": True, "checkout": now}


# --------------------------------------------------------------------------- HTTP-Handler

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                               "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenDeskSharing"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Datenschutz: standardmäßig keine Zugriffsprotokolle mit IP-Adressen
        if VERBOSE:
            super().log_message(fmt, *args)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    # -- Antworten
    def send(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, data, extra=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        headers = {"Cache-Control": "no-store"}
        headers.update(extra or {})
        self.send(status, body, "application/json; charset=utf-8", headers)

    # -- Sitzung
    def session_token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            ck = cookies.SimpleCookie(raw)
        except cookies.CookieError:
            return None
        m = ck.get(SESSION_COOKIE)
        return m.value if m else None

    def current_user(self, db):
        tok = self.session_token()
        if not tok:
            return None
        th = sha256(tok)
        row = db.execute(
            "SELECT u.*, s.expires AS _expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", (th,)
        ).fetchone()
        if not row or row["_expires"] < time.time() or not row["active"]:
            return None
        user = dict(row)
        user["_token_hash"] = th
        # gleitende Verlängerung
        if row["_expires"] - time.time() < SESSION_HOURS * 3600 - 600:
            db.execute("UPDATE sessions SET expires = ? WHERE token_hash = ?", (time.time() + SESSION_HOURS * 3600, th))
            db.commit()
        return user

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "Anfrage zu groß (max. 12 MB)")
        if not length:
            return {}
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            raise ApiError(415, "JSON erwartet")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "Ungültiges JSON")

    # -- Verteilung
    def dispatch(self, method):
        u = urlparse(self.path)
        if u.path == "/" + CA_DOWNLOAD and method == "GET" and TLS_INFO.get("ca_file"):
            with open(TLS_INFO["ca_file"], "rb") as f:
                return self.send(200, f.read(), "application/pkix-cert",
                                 {"Content-Disposition": f'attachment; filename="{CA_DOWNLOAD}"', "Cache-Control": "no-cache"})
        if u.path.startswith("/api/"):
            return self.dispatch_api(method, u)
        if method != "GET":
            return self.send_json(405, {"error": "Methode nicht erlaubt"})
        return self.serve_static(u.path)

    def dispatch_api(self, method, u):
        for m, rx, auth, pw_ok, fn in ROUTES:
            if m != method:
                continue
            mt = rx.match(u.path)
            if not mt:
                continue
            db = db_connect()
            try:
                if method != "GET" and self.headers.get("X-Requested-With") != "fetch":
                    raise ApiError(403, "Ungültige Anfrage")
                body = self.read_body() if method in ("POST", "PUT") else {}
                user = self.current_user(db)
                if auth and not user:
                    raise ApiError(401, "Nicht angemeldet")
                if auth == "admin" and user["role"] != "admin":
                    raise ApiError(403, "Keine Berechtigung")
                if auth and user["must_change_pw"] and not pw_ok:
                    raise ApiError(403, "Bitte ändern Sie zuerst Ihr Passwort")
                ctx = Ctx(db, user, parse_qs(u.query), body)
                result = fn(ctx, *mt.groups())
                db.commit()
                extra = {}
                if ctx.set_cookie is not None:
                    tok, age = ctx.set_cookie
                    secure = "; Secure" if USE_TLS else ""
                    extra["Set-Cookie"] = f"{SESSION_COOKIE}={tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}{secure}"
                return self.send_json(200, result, extra)
            except ApiError as e:
                db.rollback()
                return self.send_json(e.status, {"error": e.message})
            except sqlite3.IntegrityError as e:
                db.rollback()
                return self.send_json(409, {"error": "Datenkonflikt: " + str(e)})
            except Exception:
                db.rollback()
                traceback.print_exc()
                return self.send_json(500, {"error": "Interner Serverfehler"})
            finally:
                db.close()
        return self.send_json(404, {"error": "Nicht gefunden"})

    def serve_static(self, path):
        name = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or name.startswith("."):
            return self.send(404, b"Not found", "text/plain")
        full = os.path.join(STATIC_DIR, name)
        ext = os.path.splitext(name)[1].lower()
        if ext not in STATIC_TYPES or not os.path.isfile(full):
            return self.send(404, b"Not found", "text/plain")
        with open(full, "rb") as f:
            data = f.read()
        if name == "index.html":
            # Versionsnummer an JS/CSS anhängen, damit Browser nach einem Update nichts Veraltetes aus dem Cache nehmen
            data = data.replace(b"__VERSION__", APP_VERSION.encode())
        self.send(200, data, STATIC_TYPES[ext], {"Cache-Control": "no-cache"})


class RedirectHandler(BaseHTTPRequestHandler):
    """Unverschlüsselte Anfragen am HTTPS-Port: auf https:// umleiten (alte Lesezeichen funktionieren weiter)."""
    server_version = "OpenDeskSharing"
    sys_version = ""

    def log_message(self, fmt, *args):
        if VERBOSE:
            super().log_message(fmt, *args)

    def redirect(self):
        host = (self.headers.get("Host") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9.\-\[\]:]{1,255}", host):
            host = f"{socket.gethostname()}:{self.server.server_address[1]}"
        path = self.path if self.path.startswith("/") else "/"
        body = b"Bitte https:// verwenden."
        self.send_response(301 if self.command in ("GET", "HEAD") else 308)
        self.send_header("Location", f"https://{host}{path}")
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = redirect


# --------------------------------------------------------------------------- Start

CA_DOWNLOAD = "OpenDeskSharing-Stammzertifikat.cer"


class Server(ThreadingHTTPServer):
    ssl_ctx = None

    def finish_request(self, request, client_address):
        if self.ssl_ctx is None:
            return super().finish_request(request, client_address)
        # HTTPS und HTTP am selben Port: TLS-Verbindungen beginnen mit 0x16 (Handshake)
        request.settimeout(30)
        try:
            first = request.recv(1, socket.MSG_PEEK)
        except OSError:
            return
        if not first:
            return
        if first != b"\x16":
            return RedirectHandler(request, client_address, self)
        conn = self.ssl_ctx.wrap_socket(request, server_side=True)
        try:
            self.RequestHandlerClass(conn, client_address, self)
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def handle_error(self, request, client_address):
        # Vom Browser abgebrochene Verbindungen sind normal und gehören nicht ins Fehlerprotokoll –
        # ebenso abgelehnte Zertifikate (Browser, die dem Stammzertifikat noch nicht vertrauen)
        if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError, ssl.SSLError,
                                          socket.timeout)):
            return
        super().handle_error(request, client_address)


def open_log(path, max_bytes=5 * 1024 * 1024, keep=3):
    """Leitet stdout/stderr in eine Logdatei um; bei mehr als 5 MB wird rotiert (.1, .2, .3)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) > max_bytes:
        for i in range(keep - 1, 0, -1):
            if os.path.exists(f"{path}.{i}"):
                os.replace(f"{path}.{i}", f"{path}.{i + 1}")
        os.replace(path, f"{path}.1")
    f = open(path, "a", encoding="utf-8", errors="replace", buffering=1)
    sys.stdout = sys.stderr = f


def main():
    global USE_TLS, VERBOSE, DB_PATH, DATA_DIR, TLS_INFO
    ap = argparse.ArgumentParser(description="OpenDeskSharing – lokaler Server")
    ap.add_argument("--host", default="0.0.0.0", help="Adresse (Standard 0.0.0.0 = im Netzwerk erreichbar; 127.0.0.1 = nur lokal)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--data", default=DATA_DIR, help="Datenverzeichnis")
    ap.add_argument("--https", action="store_true", help="HTTPS mit automatisch erzeugtem Zertifikat (in <data>/tls)")
    ap.add_argument("--tls-names", default="", help="zusätzliche Namen/Adressen fürs Zertifikat, durch Komma getrennt")
    ap.add_argument("--cert", help="eigenes TLS-Zertifikat (PEM, ggf. mit Zwischenzertifikaten) für HTTPS")
    ap.add_argument("--key", help="Schlüssel (PEM) zum eigenen Zertifikat")
    ap.add_argument("--verbose", action="store_true", help="Zugriffsprotokoll ausgeben")
    ap.add_argument("--log", help="Ausgaben in diese Datei schreiben (für den Betrieb als Dienst)")
    ap.add_argument("--version", action="version", version=APP_VERSION)
    args = ap.parse_args()
    if args.log:
        open_log(args.log)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace", line_buffering=True)
        except (AttributeError, ValueError):
            pass
    print(f"[{now_iso()}] OpenDeskSharing {APP_VERSION} startet (Python {sys.version.split()[0]})")

    DATA_DIR = os.path.abspath(args.data)
    DB_PATH = os.path.join(DATA_DIR, "opendesksharing.db")
    VERBOSE = args.verbose
    init_db()
    threading.Thread(target=cleanup_loop, daemon=True).start()

    httpd = Server((args.host, args.port), Handler)
    httpd.daemon_threads = True
    scheme = "http"
    cert = key = None
    if args.cert:
        cert, key = args.cert, args.key
        TLS_INFO = {"mode": "own", "file": os.path.abspath(cert)}
    elif args.https:
        names = [n for n in args.tls_names.split(",") if n.strip()]
        cert, key, info = odstls.ensure_certs(os.path.join(DATA_DIR, "tls"), names)
        TLS_INFO = {"mode": "auto", **info}
        print(f"HTTPS: Stammzertifikat {info['ca_file']}  (Fingerabdruck SHA1 {info['ca_fingerprint']})")
    if cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(cert, key)
        httpd.ssl_ctx = ctx
        USE_TLS = True
        scheme = "https"
    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print(f"OpenDeskSharing läuft auf {scheme}://{shown}:{args.port}   (Beenden mit Strg+C)")
    print(f"Daten: {DB_PATH}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")


if __name__ == "__main__":
    try:
        main()
    except (SystemExit, KeyboardInterrupt):
        raise
    except BaseException:
        # Startfehler auch dann protokollieren, wenn die Logdatei noch nicht geöffnet war
        if "--log" in sys.argv[:-1]:
            try:
                with open(sys.argv[sys.argv.index("--log") + 1], "a", encoding="utf-8") as lf:
                    lf.write(f"[{now_iso()}] STARTFEHLER OpenDeskSharing {APP_VERSION}:\n{traceback.format_exc()}\n")
            except OSError:
                pass
        traceback.print_exc()
        sys.exit(1)
