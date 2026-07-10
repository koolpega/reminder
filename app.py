import os
import re
import json
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo
import requests
from flask import Flask, jsonify, render_template, request, make_response
import firebase_admin
from firebase_admin import credentials, db

FIREBASE_SERVICE_ACCOUNT = json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT"])
FIREBASE_DATABASE_URL = os.environ.get("FIREBASE_DATABASE_URL")

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

IST = ZoneInfo("Asia/Kolkata")

COOKIE_NAME = "access_code"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30

RANGE_KEY_RE = re.compile(r"^(\d{1,2})-(\d{1,2})$")

app = Flask(__name__)

cred = credentials.Certificate(FIREBASE_SERVICE_ACCOUNT)
firebase_admin.initialize_app(cred, {"databaseURL": FIREBASE_DATABASE_URL})

def ref(path):
    return db.reference(path)

def get_access_codes():
    """Returns a set of valid access codes, regardless of whether the RTDB
    node is stored as a list or a dict."""
    data = ref("/reminder/access_codes").get()
    if not data:
        return set()
    if isinstance(data, dict):
        return set(data.keys())
    if isinstance(data, list):
        return {str(c) for c in data if c}
    return set()

def is_authed():
    code = request.cookies.get(COOKIE_NAME)
    if not code:
        return False
    return code in get_access_codes()

def parse_range_key(key):
    m = RANGE_KEY_RE.match(key)
    if not m:
        return None
    start, end = int(m.group(1)), int(m.group(2))
    if 0 <= start < end <= 24:
        return start, end
    return None

def send_telegram(text):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    try:
        requests.post(
            url,
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"},
            timeout=10,
        )
    except requests.RequestException:
        pass

def fmt_hour(h):
    """24 -> '00' of next day, else zero-padded hour."""
    return f"{h % 24:02d}:00"


OPEN_ENDPOINTS = {"verify_code", "static"}

@app.before_request
def require_access_code():
    if request.endpoint in OPEN_ENDPOINTS:
        return None
    if request.path.startswith("/api/") and not is_authed():
        return jsonify({"error": "unauthorized", "message": "Enter a valid access code first."}), 401
    return None

@app.route("/")
def index():
    return render_template("index.html", authed=is_authed())

@app.route("/verify", methods=["POST"])
def verify_code():
    payload = request.get_json(silent=True) or {}
    code = str(payload.get("code", "")).strip()
    if not code:
        return jsonify({"ok": False, "message": "Enter a code."}), 400

    valid_codes = get_access_codes()
    if code not in valid_codes:
        return jsonify({"ok": False, "message": "That code isn't valid."}), 403

    resp = make_response(jsonify({"ok": True}))
    resp.set_cookie(
        COOKIE_NAME, code, max_age=COOKIE_MAX_AGE,
        httponly=True, samesite="Lax",
    )
    return resp

@app.route("/api/status")
def api_status():
    value = ref("/reminder/status").get()
    return jsonify({"status": value})

@app.route("/api/dates")
def api_dates():
    data = ref("/reminder/available_timings").get() or {}
    dates = []
    for date_key, ranges in data.items():
        if not ranges:
            continue
        valid_ranges = [k for k in ranges.keys() if parse_range_key(k)]
        if valid_ranges:
            dates.append(date_key)
    dates.sort()
    return jsonify({"dates": dates})

@app.route("/api/slots/<date>")
def api_slots(date):
    data = ref(f"/reminder/available_timings/{date}").get() or {}
    slots = []
    for key in data.keys():
        parsed = parse_range_key(key)
        if not parsed:
            continue
        start, end = parsed
        slots.append({
            "key": key,
            "start": start,
            "end": end,
            "label": f"{fmt_hour(start)} - {fmt_hour(end)} IST",
        })
    slots.sort(key=lambda s: s["start"])
    return jsonify({"date": date, "slots": slots})

@app.route("/api/booked_slots")
def api_booked_slots():
    data = ref("/reminder/booked_slots").get() or {}
    slots = []
    for key, val in data.items():
        if not isinstance(val, dict):
            continue
        slots.append({
            "id": key,
            "name": val.get("name", ""),
            "reason": val.get("reason", ""),
            "date": val.get("date", ""),
            "start": val.get("start"),
            "end": val.get("end"),
            "label": (
                f"{val.get('date','')} · "
                f"{fmt_hour(val.get('start', 0))} - {fmt_hour(val.get('end', 0))} IST"
            ),
        })
    slots.sort(key=lambda s: (s["date"], s["start"] or 0))
    return jsonify({"slots": slots})

@app.route("/api/book", methods=["POST"])
def api_book():
    payload = request.get_json(silent=True) or {}

    name = str(payload.get("name", "")).strip()
    reason = str(payload.get("reason", "")).strip()
    start_ms = payload.get("start_ms")
    end_ms = payload.get("end_ms")

    if not name or not reason:
        return jsonify({"ok": False, "message": "Name and reason are required."}), 400
    if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
        return jsonify({"ok": False, "message": "Missing time selection."}), 400

    start_dt = datetime.fromtimestamp(start_ms / 1000, tz=IST)
    end_dt = datetime.fromtimestamp(end_ms / 1000, tz=IST)

    if start_dt.minute != 0 or start_dt.second != 0 or end_dt.minute != 0 or end_dt.second != 0:
        return jsonify({"ok": False, "message": "Please pick times aligned to the hour."}), 400

    duration_hours = (end_ms - start_ms) / 3_600_000
    if duration_hours <= 0 or duration_hours > 1:
        return jsonify({"ok": False, "message": "A slot can be at most 1 hour long."}), 400

    date_str = start_dt.strftime("%Y-%m-%d")
    hour_start = start_dt.hour
    hour_end = hour_start + int(round(duration_hours))

    if end_dt.strftime("%Y-%m-%d") != date_str and not (end_dt.hour == 0 and end_dt.minute == 0):
        return jsonify({"ok": False, "message": "Slot must stay within a single day."}), 400
    if end_dt.hour == 0 and end_dt.minute == 0 and end_dt.strftime("%Y-%m-%d") != date_str:
        hour_end = 24

    date_ref = ref(f"/reminder/available_timings/{date_str}")
    current = date_ref.get() or {}

    match_key, match_start, match_end = None, None, None
    for key in current.keys():
        parsed = parse_range_key(key)
        if not parsed:
            continue
        r_start, r_end = parsed
        if r_start <= hour_start and hour_end <= r_end:
            match_key, match_start, match_end = key, r_start, r_end
            break

    if match_key is None:
        return jsonify({"ok": False, "message": "That slot is no longer available."}), 409

    updates = {match_key: None}
    if match_start < hour_start:
        updates[f"{match_start}-{hour_start}"] = True
    if hour_end < match_end:
        updates[f"{hour_end}-{match_end}"] = True
    date_ref.update(updates)

    slot_id = f"{date_str}_{hour_start:02d}-{hour_end:02d}_{uuid.uuid4().hex[:6]}"
    booked_at = datetime.now(tz=IST).isoformat()
    ref(f"/reminder/booked_slots/{slot_id}").set({
        "name": name,
        "reason": reason,
        "date": date_str,
        "start": hour_start,
        "end": hour_end,
        "created_at": booked_at,
    })

    send_telegram(
        "New slot booked\n"
        f"Name: {name}\n"
        f"Date: {date_str}\n"
        f"Time: {fmt_hour(hour_start)} - {fmt_hour(hour_end)} IST\n"
        f"Reason: {reason}"
    )

    return jsonify({"ok": True, "date": date_str, "start": hour_start, "end": hour_end})

@app.route("/api/reminder", methods=["POST"])
def api_reminder():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    message = str(payload.get("message", "")).strip()

    if not name or not message:
        return jsonify({"ok": False, "message": "Name and message are required."}), 400

    send_telegram(f"Reminder\nFrom: {name}\nMessage: {message}")
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
