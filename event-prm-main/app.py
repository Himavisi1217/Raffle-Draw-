import os
import random
import datetime
import uuid
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
# SECRET_KEY is used for session management and flashing messages
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret-key")

# Firebase configuration (Realtime Database URL and Secret for auth)
FIREBASE_RTDB_URL = os.getenv(
    "FIREBASE_RTDB_URL", "https://randomizer-events-default-rtdb.asia-southeast1.firebasedatabase.app"
)
FIREBASE_SECRET = os.getenv("FIREBASE_SECRET", "VvlSfG6dBnaj6KFZPSVkoARQ4MoPiITBqaP5N8Zc")

# --- HELPERS ---
def get_firebase_url(path):
    """
    Constructs the full REST API URL for Firebase.
    Append '.json' and the auth token to satisfy Firebase REST requirements.
    """
    if not path.startswith("/"):
        path = "/" + path
    return f"{FIREBASE_RTDB_URL}{path}.json?auth={FIREBASE_SECRET}"


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
    # Verify the event exists before showing the form
    event_url = get_firebase_url(f"/events/{event_id}")
    resp = requests.get(event_url)
    if resp.status_code != 200 or not resp.json():
        flash("Event not found or closed.", "danger")
        return redirect(url_for("index"))

    event_data = resp.json()
    
    if request.method == "POST":
        # Extract form data
        name = request.form.get("name", "").strip()
        mobile_number = request.form.get("mobile_number", "").strip()
        company_name = request.form.get("company_name", "").strip()
        position = request.form.get("position", "").strip()
        email = request.form.get("email", "").strip().lower()

        # Basic validation
        if not all([name, mobile_number, company_name, position, email]):
            flash("Please fill in all fields.", "danger")
            return redirect(url_for("register", event_id=event_id))

        # Check for duplicate email in this specific event to prevent double registration
        url = get_firebase_url(f"/participants/{event_id}")
        resp = requests.get(url)
        all_participants = resp.json() if resp.status_code == 200 else {}
        if isinstance(all_participants, dict):
            for pid, pdata in all_participants.items():
                if pdata.get("email") == email:
                    flash("This email is already registered for this event.", "warning")
                    return redirect(url_for("register_success", event_id=event_id))

        # Prepare participant data object
        participant_data = {
            "name": name,
            "mobile_number": mobile_number,
            "company_name": company_name,
            "position": position,
            "email": email,
            "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        
        # Save to Firebase
        post_url = get_firebase_url(f"/participants/{event_id}")
        requests.post(post_url, json=participant_data)

        return redirect(url_for("register_success", event_id=event_id))

    return render_template("register.html", event=event_data, event_id=event_id)


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
    event_url = get_firebase_url(f"/events/{event_id}")
    resp = requests.get(event_url)
    event_data = resp.json() or {}
    return render_template("wheel.html", event_id=event_id, event=event_data)


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
            # Create Event Data
            event_data = {
                "name": event_name,
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
        # Form for manual participant registration by admin
        name = request.form.get("name", "").strip()
        mobile_number = request.form.get("mobile_number", "").strip()
        company_name = request.form.get("company_name", "").strip()
        position = request.form.get("position", "").strip()
        email = request.form.get("email", "").strip().lower()

        if not all([name, mobile_number, company_name, position, email]):
            flash("Please fill in all fields.", "danger")
            return redirect(url_for("admin_event_detail", event_id=event_id))

        # Check for duplicate
        url = get_firebase_url(f"/participants/{event_id}")
        resp = requests.get(url)
        all_participants = resp.json() if resp.status_code == 200 else {}
        if isinstance(all_participants, dict):
            for pid, pdata in all_participants.items():
                if pdata.get("email") == email:
                    flash("This email is already registered for this event.", "warning")
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

    # Fetch event details and participants
    event_url = get_firebase_url(f"/events/{event_id}")
    resp = requests.get(event_url)
    event_data = resp.json()
    if not event_data:
        flash("Event not found.", "danger")
        return redirect(url_for("admin_dashboard"))
    event_data["id"] = event_id

    url = get_firebase_url(f"/participants/{event_id}")
    resp = requests.get(url)
    data = resp.json() or {}
    
    participants = []
    if isinstance(data, dict):
        for pid, pdata in data.items():
            pdata["id"] = pid
            participants.append(pdata)
            
    participants.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return render_template("event_detail.html", participants=participants, event=event_data)


@app.route("/admin/events/<event_id>/end", methods=["POST"])
@login_required
def end_event(event_id):
    """
    Completely wipes an event and its participants from the database.
    IRREVERSIBLE ACTION.
    """
    # Wipe the participants for this event
    requests.delete(get_firebase_url(f"/participants/{event_id}"))
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
