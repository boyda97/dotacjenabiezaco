"""Baza SQLite: nabory z historią zmian, profile subskrybentów, wysłane alerty."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from .models import CompanyProfile, Program

SCHEMA = """
CREATE TABLE IF NOT EXISTS programs (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    data TEXT NOT NULL,
    fingerprint TEXT NOT NULL,      -- skrót po klasyfikacji (zmiana = aktualizacja dla klientów)
    raw_fingerprint TEXT,           -- skrót surowej treści ze źródła (cache ekstrakcji AI)
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_changed TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS programs_source ON programs(source, active);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT, started TEXT, finished TEXT,
    fetched INTEGER, new INTEGER, changed INTEGER, removed INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    plan TEXT NOT NULL DEFAULT 'monthly',    -- monthly (codzienne alerty) | weekly (jednorazowy tydzień)
    active_until TEXT,                       -- koniec opłaconego dostępu (ISO)
    data TEXT NOT NULL,
    created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts_sent (
    profile_id INTEGER, program_key TEXT, fingerprint TEXT, sent_at TEXT,
    PRIMARY KEY (profile_id, program_key, fingerprint)
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str = "dotacjomat.db"):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # --- nabory ---------------------------------------------------------
    def get(self, key: str):
        r = self.db.execute("SELECT * FROM programs WHERE key=?", (key,)).fetchone()
        return (Program.from_dict(json.loads(r["data"])), r["raw_fingerprint"]) if r else (None, None)

    def upsert(self, p: Program, raw_fingerprint: Optional[str] = None) -> str:
        """Zwraca 'new' | 'changed' | 'same'."""
        ts, fp = now(), p.fingerprint()
        data = json.dumps(p.to_dict(), ensure_ascii=False)
        r = self.db.execute("SELECT fingerprint FROM programs WHERE key=?", (p.key,)).fetchone()
        if r is None:
            self.db.execute("INSERT INTO programs VALUES (?,?,?,?,?,?,?,?,1)",
                            (p.key, p.source, data, fp, raw_fingerprint, ts, ts, ts))
            return "new"
        changed = r["fingerprint"] != fp
        self.db.execute(
            "UPDATE programs SET data=?, fingerprint=?, raw_fingerprint=?, last_seen=?, active=1"
            + (", last_changed=?" if changed else "") + " WHERE key=?",
            (data, fp, raw_fingerprint, ts, *([ts] if changed else []), p.key))
        return "changed" if changed else "same"

    def deactivate_missing(self, source: str, seen_keys: set) -> int:
        rows = self.db.execute("SELECT key FROM programs WHERE source=? AND active=1", (source,)).fetchall()
        gone = [r["key"] for r in rows if r["key"] not in seen_keys]
        self.db.executemany("UPDATE programs SET active=0 WHERE key=?", [(k,) for k in gone])
        return len(gone)

    def programs(self, active_only: bool = True) -> list:
        q = "SELECT data, last_seen FROM programs" + (" WHERE active=1" if active_only else "")
        out = []
        for r in self.db.execute(q):
            p = Program.from_dict(json.loads(r["data"]))
            p.checked = (r["last_seen"] or "")[:10] or None  # kiedy źródło ostatnio potwierdziło nabór
            p.refresh_status()
            out.append(p)
        return out

    def log_run(self, source, started, stats: dict, error: Optional[str] = None):
        self.db.execute("INSERT INTO runs (source, started, finished, fetched, new, changed, removed, error)"
                        " VALUES (?,?,?,?,?,?,?,?)",
                        (source, started, now(), stats.get("fetched", 0), stats.get("new", 0),
                         stats.get("changed", 0), stats.get("removed", 0), error))

    def commit(self):
        self.db.commit()

    # --- profile i alerty ----------------------------------------------
    def add_profile(self, profile: CompanyProfile, plan: str = "monthly",
                    active_until: Optional[str] = None) -> int:
        cur = self.db.execute("INSERT INTO profiles (email, plan, active_until, data, created) VALUES (?,?,?,?,?)",
                              (profile.email, plan, active_until,
                               json.dumps(profile.to_dict(), ensure_ascii=False), now()))
        self.db.commit()
        return cur.lastrowid

    def profiles(self, only_active_at: Optional[str] = None) -> list:
        rows = self.db.execute("SELECT * FROM profiles").fetchall()
        out = []
        for r in rows:
            if only_active_at and r["active_until"] and r["active_until"] < only_active_at:
                continue
            out.append((r["id"], r["plan"], CompanyProfile.from_dict(json.loads(r["data"]))))
        return out

    def already_sent(self, profile_id: int, key: str, fingerprint: str) -> bool:
        return self.db.execute("SELECT 1 FROM alerts_sent WHERE profile_id=? AND program_key=? AND fingerprint=?",
                               (profile_id, key, fingerprint)).fetchone() is not None

    def mark_sent(self, profile_id: int, items: list):
        self.db.executemany("INSERT OR IGNORE INTO alerts_sent VALUES (?,?,?,?)",
                            [(profile_id, p.key, p.fingerprint(), now()) for p in items])
        self.db.commit()
