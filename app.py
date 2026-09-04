import os
import random
import datetime
import uuid
import csv
import io
from functools import wraps
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv
from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    flash,
    jsonify,
    session,
    send_file,
)
from werkzeug.security import generate_password_hash, check_password_hash


# --- CONFIGURATION ---
# Load environment variables from .env file
load_dotenv()

# Setup absolute paths for serverless environment
base_dir = os.path.dirname(os.path.abspath(__file__))
template_dir = os.path.join(base_dir, 'templates')
static_dir = os.path.join(base_dir, 'static')

app = Flask(__name__, 
            template_folder=template_dir, 
            static_folder=static_dir)
secret_key = os.getenv("SECRET_KEY") or os.getenv("FLASK_SECRET_KEY")
if not secret_key:
    app.logger.warning("SECRET_KEY is not configured. Set it in the environment before deployment.")
    secret_key = "__replace_with_strong_random_value__"
app.config["SECRET_KEY"] = secret_key
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = not app.debug
app.config["SESSION_COOKIE_NAME"] = "raffle_session"
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
app.config["PERMANENT_SESSION_LIFETIME"] = datetime.timedelta(hours=12)

# Firebase configuration (Realtime Database URL and Secret for auth)
FIREBASE_RTDB_URL = os.getenv(
    "FIREBASE_RTDB_URL", "https://randomizer-events-default-rtdb.asia-southeast1.firebasedatabase.app"
)
FIREBASE_SECRET = (os.getenv("FIREBASE_SECRET") or "").strip()
if not FIREBASE_SECRET:
    app.logger.warning("FIREBASE_SECRET is not configured. Set it in your environment before deploying to production.")

_ORIGINAL_REQUESTS = {
    name: getattr(requests, name)
    for name in ("get", "post", "put", "patch", "delete")
}


def _firebase_request(method_name, url, *args, **kwargs):
    """Use the original requests methods with a safer Firebase SSL fallback."""
    method = _ORIGINAL_REQUESTS[method_name]
    kwargs.setdefault("timeout", 20)
    try:
        return method(url, *args, **kwargs)
    except requests.exceptions.SSLError:
        kwargs["verify"] = False
        return method(url, *args, **kwargs)


for _method_name in ("get", "post", "put", "patch", "delete"):
    setattr(requests, _method_name, lambda url, *args, method_name=_method_name, **kwargs: _firebase_request(method_name, url, *args, **kwargs))

# --- HELPERS ---
def get_firebase_url(path):
    """
    Constructs the full REST API URL for Firebase.
    Append '.json' and the auth token to satisfy Firebase REST requirements.
    """
    if not path.startswith("/"):
        path = "/" + path
    return f"{FIREBASE_RTDB_URL}{path}.json?auth={FIREBASE_SECRET}"


def normalize_mobile_number(value):
    """Normalize phone numbers for duplicate checks while preserving the entered format."""
    return "".join(character for character in value if character.isdigit())


def normalize_name(value):
    """Normalize a participant name for duplicate detection."""
    return (value or "").strip().casefold()


def find_duplicate_participant(participants, email, mobile_number, name=None, exclude_id=None):
    """Return the duplicate field name for an event participant, if one exists."""
    normalized_email = (email or "").strip().lower()
    normalized_mobile = normalize_mobile_number(mobile_number or "")
    normalized_name = normalize_name(name)

    if not isinstance(participants, dict):
        return None

    for participant_id, participant in participants.items():
        if participant_id == exclude_id or not isinstance(participant, dict):
            continue

        existing_name = normalize_name(participant.get("name", ""))
        existing_email = (participant.get("email", "") or "").strip().lower()
        existing_mobile = normalize_mobile_number(participant.get("mobile_number", "") or "")

        if normalized_name and existing_name and normalized_email and existing_name == normalized_name and existing_email == normalized_email:
            return "name and email"
        if normalized_name and existing_name and normalized_mobile and existing_name == normalized_name and existing_mobile == normalized_mobile:
            return "name and mobile number"
        if normalized_email and existing_email == normalized_email:
            return "email"
        if normalized_mobile and existing_mobile == normalized_mobile:
            return "mobile number"
    return None


def login_required(view_func):
    """
    Decorator to protect routes that require admin authentication.
    Checks if 'admin_id' exists in the session.
    """
    @wraps(view_func)
    def wrapped_view(*args, **kwargs):
        if not session.get("admin_id"):
            flash("Please log in as admin to access this page.", "warning")
            return redirect(url_for("admin_login", next=request.path))
        return view_func(*args, **kwargs)

    return wrapped_view


@app.after_request
def add_security_headers(response):
    """Add a strong baseline security layer for browsers and session handling."""
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-XSS-Protection"] = "0"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
    response.headers["X-Permitted-Cross-Domain-Policies"] = "none"
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "base-uri 'self'; "
        "object-src 'none'; "
        "img-src 'self' data: https:; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; "
        "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; "
        "connect-src 'self' https://*.firebaseio.com https://*.firebasedatabase.app; "
        "frame-ancestors 'self'; "
        "form-action 'self'"
    )
    if not app.debug:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


def default_registration_fields():
    """Return the default registration form configuration."""
    return [
        {
            "key": "name",
            "label": "Full Name",
            "type": "text",
            "required": True,
            "placeholder": "John Doe",
            "order": 1,
        },
        {
            "key": "mobile_number",
            "label": "Mobile Number",
            "type": "tel",
            "required": True,
            "placeholder": "+94 7X XXX XXXX",
            "order": 2,
        },
        {
            "key": "company_name",
            "label": "Company Name",
            "type": "text",
            "required": True,
            "placeholder": "Acme Corp",
            "order": 3,
        },
        {
            "key": "position",
            "label": "Position",
            "type": "text",
            "required": True,
            "placeholder": "Software Engineer",
            "order": 4,
        },
        {
            "key": "email",
            "label": "Email",
            "type": "email",
            "required": True,
            "placeholder": "john@example.com",
            "order": 5,
        },
        {
            "key": "data_sharing_consent",
            "label": "I agree that my registration data may be shared with the publishers for event-related communication and administration.",
            "type": "checkbox",
            "required": True,
            "placeholder": "",
            "order": 6,
        },
    ]


def normalize_registration_fields(fields):
    """Normalize and sort field definitions into a consistent structure."""
    if not isinstance(fields, list):
        fields = default_registration_fields()
    normalized = []
    for index, field in enumerate(fields):
        if not isinstance(field, dict):
            continue
        key = (field.get("key") or field.get("name") or f"field_{index + 1}").strip()
        if not key:
            continue
        normalized.append({
            "key": key,
            "label": (field.get("label") or field.get("name") or key.replace("_", " ")).strip() or key,
            "type": field.get("type") or "text",
            "required": bool(field.get("required", False)),
            "placeholder": field.get("placeholder") or "",
            "order": int(field.get("order") or (index + 1)),
        })
    normalized.sort(key=lambda item: item.get("order", 999))
    for i, field in enumerate(normalized):
        field["order"] = i + 1
    return normalized


def get_event_registration_fields(event_data):
    """Return the registration field configuration for an event."""
    if not isinstance(event_data, dict):
        return default_registration_fields()
    return normalize_registration_fields(event_data.get("registration_fields") or default_registration_fields())


def get_event_winners(event_id):
    """Fetch the saved winner assignment map for an event."""
    resp = requests.get(get_firebase_url(f"/winners/{event_id}"))
    data = resp.json() if resp.status_code == 200 else {}
    if isinstance(data, dict):
        return data
    return {}


# --- ROUTES ---

@app.route("/")
def index():
    """Home page - simple welcome screen."""
    return render_template("index.html")


@app.route("/register/<event_id>", methods=["GET", "POST"])
def register(event_id):
    """
    Public registration page for participants of a specific event.
    GET: Display the registration form.
    POST: Save participant details to Firebase if valid.
    """
    event_url = get_firebase_url(f"/events/{event_id}")
    resp = requests.get(event_url)
    if resp.status_code != 200 or not resp.json():
        flash("Event not found or closed.", "danger")
        return redirect(url_for("index"))

    event_data = resp.json()
    registration_fields = get_event_registration_fields(event_data)

    if request.method == "POST":
        participant_data = {
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "data_sharing_consent": False,
        }
        email_value = ""
        mobile_value = ""

        for field in registration_fields:
            key = field["key"]
            value = request.form.get(key, "")
            if field["type"] == "checkbox":
                form_value = value == "on"
                participant_data[key] = form_value
                if field["required"] and not form_value:
                    flash("Please confirm the required consent field before continuing.", "warning")
                    return redirect(url_for("register", event_id=event_id))
                continue
            if field["type"] == "email":
                email_value = value.strip().lower()
            if field["key"] == "mobile_number":
                mobile_value = value.strip()
            if key:
                participant_data[key] = value.strip()

        required_missing = False
        for field in registration_fields:
            if not field.get("required"):
                continue
            if field["type"] == "checkbox":
                if not participant_data.get(field["key"], False):
                    required_missing = True
                continue
            if not str(participant_data.get(field["key"], "")).strip():
                required_missing = True

        if required_missing:
            flash("Please fill in all required fields.", "danger")
            return redirect(url_for("register", event_id=event_id))

        if email_value and mobile_value:
            url = get_firebase_url(f"/participants/{event_id}")
            resp = requests.get(url)
            all_participants = resp.json() if resp.status_code == 200 else {}
            duplicate_field = find_duplicate_participant(
                all_participants,
                email_value,
                mobile_value,
                participant_data.get("name") or participant_data.get("full_name") or "",
            )
            if duplicate_field:
                flash(
                    f"This {duplicate_field} is already registered for this event.",
                    "warning",
                )
                return redirect(url_for("register", event_id=event_id))

        participant_data["name"] = participant_data.get("name") or participant_data.get("full_name") or ""
        participant_data["data_sharing_consent"] = bool(participant_data.get("data_sharing_consent", False))
        participant_data["data_sharing_consent_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

        post_url = get_firebase_url(f"/participants/{event_id}")
        requests.post(post_url, json=participant_data)
        return redirect(url_for("register_success", event_id=event_id))

    return render_template("register.html", event=event_data, event_id=event_id, registration_fields=registration_fields)


@app.route("/success/<event_id>")
def register_success(event_id):
    """Simple confirmation page after registration."""
    return render_template("success.html", event_id=event_id)


@app.route("/admin/events/<event_id>/wheel")
@login_required
def wheel(event_id):
    """
    The main interactive spinning wheel page.
    Requires admin login.
    """
    presentation_mode = request.args.get("presentation") == "1"
    event_url = get_firebase_url(f"/events/{event_id}")
    resp = requests.get(event_url)
    event_data = resp.json() or {}
    prize_resp = requests.get(get_firebase_url(f"/prizes/{event_id}"))
    prize_data = prize_resp.json() if prize_resp.status_code == 200 else {}
    participant_resp = requests.get(get_firebase_url(f"/participants/{event_id}"))
    participant_data = participant_resp.json() if participant_resp.status_code == 200 else {}
    initial_prizes = []
    initial_participants = []
    if isinstance(prize_data, dict):
        for prize_id, prize in prize_data.items():
            if isinstance(prize, dict):
                prize = dict(prize)
                prize["id"] = prize_id
                initial_prizes.append(prize)
    if isinstance(participant_data, dict):
        for participant_id, participant in participant_data.items():
            if isinstance(participant, dict):
                participant = dict(participant)
                participant["id"] = participant_id
                initial_participants.append(participant)
    initial_prizes.sort(key=lambda item: (int(item.get("sort_order") or 0), item.get("created_at", "")))
    initial_participants.sort(key=lambda item: item.get("created_at", ""))
    return render_template(
        "wheel.html",
        event_id=event_id,
        event=event_data,
        initial_prizes=initial_prizes,
        initial_participants=initial_participants,
        presentation_mode=presentation_mode,
    )


@app.route("/api/winners/<event_id>", methods=["GET", "POST", "DELETE"])
@login_required
def api_winners(event_id):
    """Store and retrieve prize to winner assignments for an event."""
    winners_url = get_firebase_url(f"/winners/{event_id}")
    if request.method == "GET":
        winners = get_event_winners(event_id)
        return jsonify(winners)

    if request.method == "DELETE":
        requests.delete(winners_url)
        return jsonify({"status": "cleared"})

    payload = request.get_json(silent=True) or {}
    prize_id = str(payload.get("prize_id") or "").strip()
    winner_id = str(payload.get("winner_id") or "").strip()
    prize_name = (payload.get("prize_name") or "Prize").strip()
    winner_name = (payload.get("winner_name") or "Winner").strip()

    if not prize_id or not winner_id:
        return jsonify({"error": "Prize and winner are required."}), 400

    existing = get_event_winners(event_id)
    winner_ids = {
        str(entry.get("winner_id") or "")
        for entry in existing.values()
        if isinstance(entry, dict) and str(entry.get("winner_id") or "").strip()
    }
    if str(winner_id).strip() in winner_ids:
        return jsonify({"error": "This participant has already won a prize in this event."}), 409

    existing[prize_id] = {
        "prize_id": prize_id,
        "winner_id": winner_id,
        "prize_name": prize_name,
        "winner_name": winner_name,
        "selected_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    requests.put(winners_url, json=existing)
    return jsonify({"status": "saved", "winner": existing[prize_id]})


@app.route("/api/participants/<event_id>")
@login_required
def api_participants(event_id):
    """
    API endpoint that returns a sorted list of participants for a given event.
    Used by the wheel.js to populate the wheel segments.
    """
    url = get_firebase_url(f"/participants/{event_id}")
    resp = requests.get(url)
    data = resp.json() or {}
    
    participants = []
    # Firebase returns a dict with auto-generated IDs as keys; we convert it to a list
    if isinstance(data, dict):
        for pid, pdata in data.items():
            pdata["id"] = pid
            participants.append(pdata)
            
    # Sort by registration time
    participants.sort(key=lambda x: x.get("created_at", ""))
    return jsonify(participants)


@app.route("/api/prizes/<event_id>")
@login_required
def api_prizes(event_id):
    """
    API endpoint that returns a list of prizes for a given event.
    Used by the wheel.js to populate the wheel segments.
    """
    url = get_firebase_url(f"/prizes/{event_id}")
    resp = requests.get(url)
    if resp.status_code != 200:
        return jsonify({"error": "Unable to load prizes."}), 502
    data = resp.json() or {}
    
    prizes = []
    if isinstance(data, dict):
        for pid, pdata in data.items():
            if isinstance(pdata, dict):
                pdata = dict(pdata)
                pdata["id"] = pid
                prizes.append(pdata)

    prizes.sort(key=lambda item: (int(item.get("sort_order") or 0), item.get("created_at", "")))
    return jsonify(prizes)


@app.route("/api/random-winners/<event_id>")
@login_required
def api_random_winners(event_id):
    """
    API endpoint to pick random winners from the current participant pool.
    Useful if pick-logic needs to happen server-side.
    """
    try:
        count = int(request.args.get("count", "1"))
    except ValueError:
        count = 1

    url = get_firebase_url(f"/participants/{event_id}")
    resp = requests.get(url)
    data = resp.json() or {}
    
    participants = []
    if isinstance(data, dict):
        for pid, pdata in data.items():
            pdata["id"] = pid
            participants.append(pdata)

    if not participants:
        return jsonify({"winners": []})

    # Pick random samples without replacement up to 'count'
    count = min(count, len(participants))
    winners = random.sample(participants, count)

    return jsonify({"winners": winners})


@app.route("/admin", methods=["GET", "POST"])
@login_required
def admin_dashboard():
    """
    Main Admin area where users can view all events and create new ones.
    """
    if request.method == "POST":
        event_name = request.form.get("event_name", "").strip()
        if event_name:
            portal_title = request.form.get("portal_title", event_name).strip() or event_name
            banner_title = request.form.get("banner_title", event_name).strip() or event_name
            banner_subtitle = request.form.get("banner_subtitle", "").strip()
            banner_message = request.form.get("banner_message", "").strip()
            accent_color = request.form.get("accent_color", "#5FE0A5").strip() or "#5FE0A5"

            # Create Event Data
            event_data = {
                "name": event_name,
                "portal_title": portal_title,
                "banner_title": banner_title,
                "banner_subtitle": banner_subtitle,
                "banner_message": banner_message,
                "accent_color": accent_color,
                "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "admin_id": session.get("admin_id")
            }
            # Post new event to Firebase
            post_url = get_firebase_url("/events")
            requests.post(post_url, json=event_data)
            flash("Event created successfully.", "success")
            return redirect(url_for("admin_dashboard"))
            
    # Fetch all events
    url = get_firebase_url("/events")
    resp = requests.get(url)
    data = resp.json() or {}
    
    events = []
    if isinstance(data, dict):
        for eid, edata in data.items():
            edata["id"] = eid
            events.append(edata)
        
    # Show newest events first
    events.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return render_template("admin_dashboard.html", events=events)


@app.route("/admin/events/<event_id>", methods=["GET", "POST"])
@login_required
def admin_event_detail(event_id):
    """
    Detailed view of an event including the list of registered participants.
    Admins can also manually add participants here.
    """
    if request.method == "POST":
        form_type = request.form.get("form_type")

        if form_type == "event_settings":
            title = request.form.get("portal_title", "").strip() or request.form.get("event_name", "").strip()
            subtitle = request.form.get("banner_subtitle", "").strip()
            banner_title = request.form.get("banner_title", "").strip()
            banner_image = request.form.get("banner_image", "").strip()
            accent_color = request.form.get("accent_color", "#5FE0A5").strip()

            if not title:
                flash("Event title is required.", "danger")
                return redirect(url_for("admin_event_detail", event_id=event_id))

            allowed_banner_image_prefixes = (
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/gif;base64,",
                "data:image/webp;base64,",
            )
            if banner_image and (not banner_image.startswith(allowed_banner_image_prefixes) or len(banner_image) > 4 * 1024 * 1024):
                flash("Please choose an image smaller than 3 MB.", "danger")
                return redirect(url_for("admin_event_detail", event_id=event_id))

            event_payload = {
                "name": title,
                "portal_title": title,
                "banner_title": banner_title or title,
                "banner_subtitle": subtitle,
                "banner_image": banner_image,
                "accent_color": accent_color,
                "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
            }
            requests.patch(get_firebase_url(f"/events/{event_id}"), json=event_payload)
            flash("Event branding and title updated successfully.", "success")
            return redirect(url_for("admin_event_detail", event_id=event_id))

        if form_type == "registration_form_settings":
            field_keys = request.form.getlist("field_key")
            field_labels = request.form.getlist("field_label")
            field_types = request.form.getlist("field_type")
            field_required = request.form.getlist("field_required")
            field_placeholders = request.form.getlist("field_placeholder")

            fields = []
            for index, key in enumerate(field_keys):
                key = (key or "").strip()
                if not key:
                    continue
                label = (field_labels[index] if index < len(field_labels) else "").strip() or key.replace("_", " ").title()
                field_type = (field_types[index] if index < len(field_types) else "text").strip() or "text"
                fields.append({
                    "key": key,
                    "label": label,
                    "type": field_type,
                    "required": key in field_required,
                    "placeholder": (field_placeholders[index] if index < len(field_placeholders) else "").strip(),
                    "order": index + 1,
                })

            if not fields:
                fields = default_registration_fields()
            event_payload = {
                "registration_fields": fields,
                "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            requests.patch(get_firebase_url(f"/events/{event_id}"), json=event_payload)
            flash("Registration form fields updated successfully.", "success")
            return redirect(url_for("admin_event_detail", event_id=event_id))

        name = request.form.get("name", "").strip()
        mobile_number = request.form.get("mobile_number", "").strip()
        company_name = request.form.get("company_name", "").strip()
        position = request.form.get("position", "").strip()
        email = request.form.get("email", "").strip().lower()

        if not all([name, mobile_number, company_name, position, email]):
            flash("Please fill in all fields.", "danger")
            return redirect(url_for("admin_event_detail", event_id=event_id))

        url = get_firebase_url(f"/participants/{event_id}")
        resp = requests.get(url)
        all_participants = resp.json() if resp.status_code == 200 else {}
        duplicate_field = find_duplicate_participant(
            all_participants,
            email,
            mobile_number,
            name,
        )
        if duplicate_field:
            flash(
                f"This {duplicate_field} is already registered for this event.",
                "warning",
            )
            return redirect(url_for("admin_event_detail", event_id=event_id))

        participant_data = {
            "name": name,
            "mobile_number": mobile_number,
            "company_name": company_name,
            "position": position,
            "email": email,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        
        post_url = get_firebase_url(f"/participants/{event_id}")
        requests.post(post_url, json=participant_data)
        flash("Participant added manually.", "success")
        return redirect(url_for("admin_event_detail", event_id=event_id))

    event_url = get_firebase_url(f"/events/{event_id}")
    resp = requests.get(event_url)
    event_data = resp.json()
    if not event_data:
        flash("Event not found.", "danger")
        return redirect(url_for("admin_dashboard"))
    event_data["id"] = event_id
    event_data["registration_fields"] = get_event_registration_fields(event_data)

    url = get_firebase_url(f"/participants/{event_id}")
    resp = requests.get(url)
    data = resp.json() or {}
    participants = []
    if isinstance(data, dict):
        for pid, pdata in data.items():
            pdata["id"] = pid
            participants.append(pdata)
    participants.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    url = get_firebase_url(f"/prizes/{event_id}")
    resp = requests.get(url)
    data = resp.json() or {}
    prizes = []
    if isinstance(data, dict):
        for index, (pid, pdata) in enumerate(data.items()):
            if not isinstance(pdata, dict):
                continue
            pdata = dict(pdata)
            pdata["id"] = pid
            pdata["sort_order"] = int(pdata.get("sort_order") or (index + 1))
            prizes.append(pdata)
    prizes.sort(key=lambda item: (int(item.get("sort_order") or 0), item.get("created_at", "")))

    return render_template("event_detail.html", participants=participants, prizes=prizes, event=event_data, registration_fields=event_data["registration_fields"])


@app.route("/admin/events/<event_id>/end", methods=["POST"])
@login_required
def end_event(event_id):
    """
    Completely wipes an event and its participants from the database.
    IRREVERSIBLE ACTION.
    """
    # Wipe the participants for this event
    requests.delete(get_firebase_url(f"/participants/{event_id}"))
    # Wipe the prizes for this event
    requests.delete(get_firebase_url(f"/prizes/{event_id}"))
    # Wipe the entry from the events list
    requests.delete(get_firebase_url(f"/events/{event_id}"))
    flash("Event and all its participants have been completely wiped and removed.", "success")
    return redirect(url_for("admin_dashboard"))


@app.route("/admin/events/<event_id>/participants/<participant_id>/delete", methods=["POST"])
@login_required
def delete_participant(event_id, participant_id):
    """Deletes a single participant from an event."""
    url = get_firebase_url(f"/participants/{event_id}/{participant_id}")
    requests.delete(url)
    flash("Participant deleted.", "success")
    return redirect(url_for("admin_event_detail", event_id=event_id))


@app.route("/admin/events/<event_id>/participants/export")
@login_required
def export_participants(event_id):
    """Download all event participants as an Excel-compatible CSV file."""
    event_resp = requests.get(get_firebase_url(f"/events/{event_id}"))
    event_data = event_resp.json() if event_resp.status_code == 200 else {}
    if not event_data:
        flash("Event not found.", "danger")
        return redirect(url_for("admin_dashboard"))

    participants_resp = requests.get(get_firebase_url(f"/participants/{event_id}"))
    participants_data = participants_resp.json() if participants_resp.status_code == 200 else {}

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Name", "Mobile Number", "Company", "Position", "Email", "Data Sharing Consent", "Registered At"])
    if isinstance(participants_data, dict):
        for participant in participants_data.values():
            if isinstance(participant, dict):
                writer.writerow([
                    participant.get("name", ""),
                    participant.get("mobile_number", ""),
                    participant.get("company_name", ""),
                    participant.get("position", ""),
                    participant.get("email", ""),
                    "Yes" if participant.get("data_sharing_consent") else "No",
                    participant.get("created_at", ""),
                ])

    filename = f"{event_data.get('name', 'event').strip() or 'event'}_participants.csv"
    return send_file(
        io.BytesIO(output.getvalue().encode("utf-8-sig")),
        mimetype="text/csv",
        as_attachment=True,
        download_name=filename,
    )


@app.route("/admin/events/<event_id>/prizes/add", methods=["POST"])
@login_required
def add_prize(event_id):
    """Manually adds a prize to an event."""
    name = request.form.get("name", "").strip()
    if not name:
        flash("Prize name is required.", "danger")
        return redirect(url_for("admin_event_detail", event_id=event_id))

    prize_resp = requests.get(get_firebase_url(f"/prizes/{event_id}"))
    prizes = prize_resp.json() if prize_resp.status_code == 200 else {}
    existing_prizes = prizes if isinstance(prizes, dict) else {}
    next_sort = len(existing_prizes) + 1

    prize_data = {
        "name": name,
        "sort_order": next_sort,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }
    
    post_url = get_firebase_url(f"/prizes/{event_id}")
    response = requests.post(post_url, json=prize_data)
    if response.status_code not in (200, 201):
        flash("Prize could not be saved. Please try again.", "danger")
        return redirect(url_for("admin_event_detail", event_id=event_id))
    flash("Prize added manually.", "success")
    return redirect(url_for("admin_event_detail", event_id=event_id))


@app.route("/admin/events/<event_id>/prizes/reorder", methods=["POST"])
@login_required
def reorder_prizes(event_id):
    """Reorder prizes by the selected priority value."""
    prize_id = (request.form.get("prize_id") or "").strip()
    sort_order_raw = request.form.get("sort_order", "1").strip()

    try:
        sort_order = int(sort_order_raw)
    except (TypeError, ValueError):
        return jsonify({"error": "Priority must be a valid number."}), 400

    if not prize_id:
        return jsonify({"error": "Prize ID is required."}), 400

    prizes_url = get_firebase_url(f"/prizes/{event_id}")
    prizes_resp = requests.get(prizes_url)
    data = prizes_resp.json() if prizes_resp.status_code == 200 else {}

    if not isinstance(data, dict):
        return jsonify({"error": "No prizes found for this event."}), 404

    prizes = []
    for current_id, prize_data in data.items():
        if not isinstance(prize_data, dict):
            continue
        prize = dict(prize_data)
        prize["id"] = current_id
        prizes.append(prize)

    selected = next((prize for prize in prizes if str(prize.get("id")) == str(prize_id)), None)
    if selected is None:
        return jsonify({"error": "Prize not found."}), 404

    current_order = sorted(prizes, key=lambda item: (int(item.get("sort_order") or 0), str(item.get("created_at") or "")))
    current_order = [item for item in current_order if str(item.get("id")) != str(prize_id)]
    target_index = max(0, min(len(current_order), sort_order - 1))
    current_order.insert(target_index, selected)

    for index, prize in enumerate(current_order, start=1):
        prize["sort_order"] = index
        requests.patch(get_firebase_url(f"/prizes/{event_id}/{prize['id']}"), json={"sort_order": index})

    return jsonify({"status": "updated", "sort_order": sort_order})


@app.route("/admin/events/<event_id>/prizes/<prize_id>/delete", methods=["POST"])
@login_required
def delete_prize(event_id, prize_id):
    """Deletes a single prize from an event."""
    url = get_firebase_url(f"/prizes/{event_id}/{prize_id}")
    requests.delete(url)
    flash("Prize deleted.", "success")
    return redirect(url_for("admin_event_detail", event_id=event_id))


@app.route("/admin/events/<event_id>/participants/<participant_id>/edit", methods=["GET", "POST"])
@login_required
def edit_participant(event_id, participant_id):
    """Edit existing participant details."""
    url = get_firebase_url(f"/participants/{event_id}/{participant_id}")
    resp = requests.get(url)
    participant = resp.json()
    
    if not participant:
        flash("Participant not found.", "danger")
        return redirect(url_for("admin_event_detail", event_id=event_id))
        
    participant["id"] = participant_id

    if request.method == "POST":
        participant["name"] = request.form.get("name", "").strip()
        participant["mobile_number"] = request.form.get("mobile_number", "").strip()
        participant["company_name"] = request.form.get("company_name", "").strip()
        participant["position"] = request.form.get("position", "").strip()
        participant["email"] = request.form.get("email", "").strip().lower()

        if not all([
            participant["name"],
            participant["mobile_number"],
            participant["company_name"],
            participant["position"],
            participant["email"]
        ]):
            flash("All fields are required.", "danger")
            return redirect(url_for("edit_participant", event_id=event_id, participant_id=participant_id))

        participants_url = get_firebase_url(f"/participants/{event_id}")
        participants_resp = requests.get(participants_url)
        all_participants = (
            participants_resp.json() if participants_resp.status_code == 200 else {}
        )
        duplicate_field = find_duplicate_participant(
            all_participants,
            participant["email"],
            participant["mobile_number"],
            participant["name"],
            exclude_id=participant_id,
        )
        if duplicate_field:
            flash(
                f"This {duplicate_field} is already registered for this event.",
                "warning",
            )
            return redirect(
                url_for(
                    "edit_participant",
                    event_id=event_id,
                    participant_id=participant_id,
                )
            )

        # Update record in Firebase
        put_url = get_firebase_url(f"/participants/{event_id}/{participant_id}")
        data_to_save = participant.copy()
        data_to_save.pop("id", None)
        requests.put(put_url, json=data_to_save)
        
        flash("Participant updated.", "success")
        return redirect(url_for("admin_event_detail", event_id=event_id))

    return render_template("edit_participant.html", participant=participant, event_id=event_id)


@app.route("/admin/signup", methods=["GET", "POST"])
def admin_signup():
    """
    Route for creating new admin accounts.
    Requires a secret 'ADMIN_SECRET_CODE' to prevent unauthorized signups.
    """
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "").strip()
        confirm_password = request.form.get("confirm_password", "").strip()
        secret_code = request.form.get("secret_code", "").strip()

        if not all([email, password, confirm_password, secret_code]):
            flash("Please fill in all fields.", "danger")
            return redirect(url_for("admin_signup"))

        if password != confirm_password:
            flash("Passwords do not match.", "danger")
            return redirect(url_for("admin_signup"))

        # Verify registration code
        expected_code = os.getenv("ADMIN_SECRET_CODE", "sltm@admin123")
        if secret_code != expected_code:
            flash("Invalid admin secret code.", "danger")
            return redirect(url_for("admin_signup"))

        # Check if admin already exists
        url = get_firebase_url("/admin_users")
        resp = requests.get(url)
        all_admins = resp.json() if resp.status_code == 200 else {}
        if isinstance(all_admins, dict):
            for pid, pdata in all_admins.items():
                if pdata.get("email") == email:
                    flash("An admin with this email already exists.", "warning")
                    return redirect(url_for("admin_login"))

        # Create new admin entry with hashed password
        admin_data = {
            "email": email,
            "password_hash": generate_password_hash(password),
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        post_url = get_firebase_url("/admin_users")
        requests.post(post_url, json=admin_data)

        flash("Admin account created. You can now log in.", "success")
        return redirect(url_for("admin_login"))

    return render_template("admin_signup.html")


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    """
    Admin authentication page.
    """
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "").strip()

        # Fetch all admin records to find a match
        url = get_firebase_url("/admin_users")
        resp = requests.get(url)
        all_admins = resp.json() if resp.status_code == 200 else {}
        
        admin_id = None
        admin_data = None
        if isinstance(all_admins, dict):
            for pid, pdata in all_admins.items():
                if pdata.get("email") == email:
                    admin_id = pid
                    admin_data = pdata
                    break
        
        if not admin_data:
            flash("Invalid email or password.", "danger")
            return redirect(url_for("admin_login"))

        # Verify hashed password
        if not check_password_hash(admin_data.get("password_hash", ""), password):
            flash("Invalid email or password.", "danger")
            return redirect(url_for("admin_login"))

        # Set session and redirect
        session["admin_id"] = admin_id
        flash("Logged in successfully.", "success")

        next_url = request.args.get("next") or url_for("admin_dashboard")
        return redirect(next_url)

    return render_template("admin_login.html")


@app.route("/admin/logout")
@login_required
def admin_logout():
    """Clear admin session."""
    session.pop("admin_id", None)
    flash("Logged out.", "info")
    return redirect(url_for("index"))


# --- ENTRY POINT ---
if __name__ == "__main__":
    # Runs the server locally. Make sure FIREBASE variables are in .env
    app.run(host="0.0.0.0", port=5000, debug=True)
