#### # ================================================================
# SOLAR-POWERED ADAPTIVE IRRIGATION SIMULATOR
# Kaggle-ready | Python standard library only
#
# ACTIVE METHOD: Need-Weighted Nash Bargaining (No Fairness Credits)
# BENCHMARKS:2
# 1. FCFS
# 2. Equal Allocation
# 3. Need-Proportional Allocation
# 4. Need-Weighted Nash Bargaining (our active method)
# ================================================================

import json
import math
import os
import random
import secrets
import hashlib
import hmac
from pathlib import Path
from datetime import date, datetime, timedelta

BASE_DIR = Path.cwd()
FARMERS_FILE = BASE_DIR / "irrigation_farmers.json"
CONFIG_FILE = BASE_DIR / "irrigation_config.json"
ADMIN_FILE = BASE_DIR / "irrigation_admin.json"
AUDIT_FILE = BASE_DIR / "irrigation_audit.log"

ACTIVE_STRATEGY = "Need-Weighted Nash Bargaining"

DEFAULT_CONFIG = {
    "pipe_capacity_lpm": 10.0,
    "valve_flow_lpm": 5.0,
    "operating_window_minutes": 240.0,
    "soil_sensor_noise": 2.0,
    "flow_sensor_noise": 0.02,
    "target_moisture": 70.0,
    "reference_et0_mm_day": 5.0,  # baseline only; use local weather-station/API ET0 for real operation
    "effective_rainfall_mm_day": 0.0,  # replace with measured effective rainfall when available
    "irrigation_efficiency": 0.85,
    "random_seed": 42
}

# Crop reference data for Tamil Nadu / South Indian demo farms.
# Kc values are FAO-56 single crop-coefficient reference values (initial,
# mid-season, end-season); stage dates are approximated from crop duration.
# Planting months are a simplified regional calendar derived from TNAU
# cropping-pattern calendars; district, cultivar, and irrigation method vary.
CROP_DATA = {
    "Rice (Paddy)": {"duration_days": 120, "kc": (1.05, 1.20, 0.90), "planting_months": (6, 7, 8, 9, 10, 11, 12, 1, 2), "season": "Sornavari/Kuruvai or Samba/Thaladi depending on district"},
    "Groundnut": {"duration_days": 110, "kc": (0.40, 1.15, 0.60), "planting_months": (1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12), "season": "varies by zone; rainfed and irrigated windows"},
    "Green gram": {"duration_days": 65, "kc": (0.40, 1.05, 0.35), "planting_months": (10, 11, 12, 1, 2, 3, 4), "season": "Rabi/summer windows vary by district"},
    "Black gram": {"duration_days": 70, "kc": (0.40, 1.05, 0.35), "planting_months": (10, 11, 12, 1, 2, 3, 4), "season": "Rabi and rice-fallow windows vary by district"},
    "Maize": {"duration_days": 110, "kc": (0.30, 1.20, 0.60), "planting_months": (1, 2, 3, 6, 7, 8, 9, 10, 11, 12), "season": "multiple seasons depending on zone"},
    "Sugarcane": {"duration_days": 365, "kc": (0.40, 1.25, 0.75), "planting_months": tuple(range(1, 13)), "season": "long-duration crop; planting window varies by district"},
    "Banana": {"duration_days": 365, "kc": (0.50, 1.10, 1.00), "planting_months": tuple(range(1, 13)), "season": "commonly grown year-round with local scheduling"},
    "Sorghum (Jowar)": {"duration_days": 110, "kc": (0.30, 1.00, 0.55), "planting_months": (6, 7, 8, 9, 10, 11, 12, 1, 2), "season": "rainfed windows vary by zone"},
    "Pearl millet (Cumbu)": {"duration_days": 85, "kc": (0.30, 1.00, 0.55), "planting_months": (6, 7, 8, 9, 10, 11, 12, 1, 2), "season": "rainfed windows vary by zone"},
    "Ragi (Finger millet)": {"duration_days": 110, "kc": (0.30, 1.00, 0.60), "planting_months": (4, 5, 6, 7, 8, 9, 10, 11), "season": "district-specific rainfed/irrigated windows"},
    "Cotton": {"duration_days": 160, "kc": (0.35, 1.15, 0.70), "planting_months": (6, 7, 8, 9, 10), "season": "mainly monsoon-season planting; local variation"},
    "Sesame (Gingelly)": {"duration_days": 90, "kc": (0.35, 1.10, 0.25), "planting_months": (1, 2, 3, 4, 5, 6, 9, 10, 11, 12), "season": "multiple local sowing windows"},
    "Tomato": {"duration_days": 120, "kc": (0.60, 1.15, 0.80), "planting_months": tuple(range(1, 13)), "season": "vegetable crop; season depends on district and variety"},
    # Legacy saved records only; Wheat is not offered as a current Tamil Nadu demo crop.
    "Wheat": {"duration_days": 120, "kc": (0.70, 1.15, 0.80), "planting_months": (11, 12, 1), "season": "legacy record only; verify local suitability"},
}
CROPS = tuple(crop for crop in CROP_DATA if crop != "Wheat")
LEGACY_CROP_MAP = {"Rice": "Rice (Paddy)"}



# ======================== FILE HANDLING ==========================

def load_json(path, default):
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        print("Warning: Could not read", path.name)
        return default


def save_json(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with open(temporary, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(temporary, path)


def audit(actor, message):
    with open(AUDIT_FILE, "a", encoding="utf-8") as f:
        f.write(
            f"[{datetime.now().isoformat(timespec='seconds')}] "
            f"{actor}: {message}\n"
        )


CONFIG = DEFAULT_CONFIG.copy()
saved_config = load_json(CONFIG_FILE, {})
if isinstance(saved_config, dict):
    CONFIG.update(saved_config)

FARMERS = load_json(FARMERS_FILE, [])
if not isinstance(FARMERS, list):
    FARMERS = []
# Migrate old saved data: discard the retired fairness-credit field entirely.
for _farmer in FARMERS:
    if isinstance(_farmer, dict):
        _farmer.pop("fairness_credit", None)
        _farmer["crop"] = LEGACY_CROP_MAP.get(_farmer.get("crop"), _farmer.get("crop"))


def save_farmers():
    save_json(FARMERS_FILE, FARMERS)


# ======================== INPUT HELPERS ==========================

def ask_number(prompt, minimum=0, maximum=None, integer=False):
    while True:
        raw = input(prompt).strip()

        if raw.upper() == "B":
            return None

        try:
            value = int(raw) if integer else float(raw)

            if not math.isfinite(value):
                raise ValueError
            if value < minimum:
                raise ValueError
            if maximum is not None and value > maximum:
                raise ValueError

            return value

        except ValueError:
            print("Invalid value. Try again or enter B to go back.")


def ask_date(prompt):
    while True:
        raw = input(prompt).strip()

        if raw == "0":
            return None

        try:
            return datetime.strptime(raw, "%d-%m-%Y").date()
        except ValueError:
            print("Use DD-MM-YYYY, or enter 0 to cancel.")


def print_table(rows):
    if not rows:
        print("No data.")
        return

    columns = list(rows[0].keys())
    widths = {}

    for column in columns:
        widths[column] = max(
            len(str(column)),
            *[len(str(row.get(column, ""))) for row in rows]
        )

    print(" | ".join(str(c).ljust(widths[c]) for c in columns))
    print("-+-".join("-" * widths[c] for c in columns))

    for row in rows:
        print(
            " | ".join(
                str(row.get(c, "")).ljust(widths[c])
                for c in columns
            )
        )


# ======================== ADMIN LOGIN =============================

def create_password_record(password):
    salt = secrets.token_bytes(16)

    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=32
    )

    return {
        "salt": salt.hex(),
        "hash": digest.hex()
    }


def check_password(password, record):
    try:
        salt = bytes.fromhex(record["salt"])
        expected = bytes.fromhex(record["hash"])

        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=2**14,
            r=8,
            p=1,
            dklen=32
        )

        return hmac.compare_digest(actual, expected)

    except (KeyError, ValueError, TypeError):
        return False



def change_admin_credentials(current_username):
    """Change admin username and/or password after verifying current password."""
    record = load_json(ADMIN_FILE, {})
    if not record:
        print("Admin credentials are missing. Recreate the admin account setup.")
        return current_username

    print("\n--- CHANGE ADMIN CREDENTIALS ---")
    current_password = input("Enter current admin password (B to cancel): ")
    if current_password.upper() == "B":
        print("Cancelled.")
        return current_username

    if not check_password(current_password, record):
        print("Current password is incorrect. Credentials were not changed.")
        audit(current_username, "Failed admin credential-change verification")
        return current_username

    new_username = input(
        f"New username (press Enter to keep '{record.get('username', current_username)}'): "
    ).strip()
    if not new_username:
        new_username = record.get("username", current_username)

    change_password = input("Change password too? (y/N): ").strip().lower()
    new_record = dict(record)
    new_record["username"] = new_username

    if change_password == "y":
        while True:
            new_password = input("New password (minimum 10 characters, 0 to cancel): ")
            if new_password == "0":
                print("Password change cancelled; no credentials were changed.")
                return current_username
            if len(new_password) < 10:
                print("Password must have at least 10 characters.")
                continue
            confirm = input("Confirm new password: ")
            if new_password != confirm:
                print("Passwords do not match. Try again.")
                continue
            new_record.pop("salt", None)
            new_record.pop("hash", None)
            new_record.update(create_password_record(new_password))
            break

    save_json(ADMIN_FILE, new_record)
    audit(new_username, "Changed administrator credentials")
    print("Admin credentials updated successfully. Use the new username next time you log in.")
    return new_username



def admin_login():
    if not ADMIN_FILE.exists():
        print("\nFirst-time administrator setup.")

        username = input("Create admin username (0 to cancel): ").strip()
        if not username or username == "0":
            return None

        while True:
            password = input("Create password, minimum 10 characters: ")

            if password == "0":
                return None

            if len(password) < 10:
                print("Password must have at least 10 characters.")
                continue

            confirm = input("Confirm password: ")

            if password != confirm:
                print("Passwords do not match.")
                continue

            record = {
                "username": username,
                **create_password_record(password)
            }

            save_json(ADMIN_FILE, record)
            audit(username, "Created administrator account")
            print("Admin account created.")
            break

    record = load_json(ADMIN_FILE, {})

    for attempt in range(3):
        username = input("Admin username (0 to cancel): ").strip()

        if username == "0":
            return None

        password = input("Admin password: ")

        if (
            username == record.get("username")
            and check_password(password, record)
        ):
            audit(username, "Successful login")
            return username

        print("Incorrect credentials.")

    print("Login attempt limit reached for this session.")
    return None


# ======================== FARMER REGISTRATION ====================

def choose_crop_age():
    print("\n1. Enter planting date")
    print("2. Enter crop age in days")
    print("0. Cancel")

    while True:
        choice = input("Choose: ").strip()

        if choice == "0":
            return None

        if choice == "1":
            planted = ask_date("Planting date DD-MM-YYYY: ")

            if planted is None:
                return None

            print("1. Use today's date")
            print("2. Enter current date manually")
            print("0. Cancel")

            option = input("Choose: ").strip()

            if option == "0":
                return None
            elif option == "1":
                current = date.today()
            elif option == "2":
                current = ask_date("Current date DD-MM-YYYY: ")
                if current is None:
                    return None
            else:
                print("Invalid choice.")
                continue

            age = (current - planted).days

            if age < 0:
                print("Planting date cannot be in the future.")
                continue

            return {
                "planting_date": planted.isoformat(),
                "current_date": current.isoformat(),
                "crop_age_days": age
            }

        elif choice == "2":
            age = ask_number(
                "Crop age in days (B to cancel): ",
                minimum=0,
                maximum=3650,
                integer=True
            )

            if age is None:
                return None

            print("1. Use today's date")
            print("2. Enter current date manually")
            print("0. Cancel")

            option = input("Choose: ").strip()

            if option == "0":
                return None
            elif option == "1":
                current = date.today()
            elif option == "2":
                current = ask_date("Current date DD-MM-YYYY: ")
                if current is None:
                    return None
            else:
                print("Invalid choice.")
                continue

            planted = current - timedelta(days=age)

            return {
                "planting_date": planted.isoformat(),
                "current_date": current.isoformat(),
                "crop_age_days": age
            }

        else:
            print("Choose 1, 2 or 0.")


def crop_coefficient(crop, age):
    """Interpolate FAO-56 Kc reference values across approximate crop stages."""
    data = CROP_DATA[crop]
    duration = data["duration_days"]
    kc_ini, kc_mid, kc_end = data["kc"]
    age = max(0, min(int(age), duration))
    # Generic stage split: 20% initial, 60% development/mid-season, 20% late.
    initial_end = 0.20 * duration
    mid_end = 0.80 * duration
    if age <= initial_end:
        return kc_ini
    if age <= mid_end:
        fraction = (age - initial_end) / max(1.0, mid_end - initial_end)
        return kc_ini + fraction * (kc_mid - kc_ini)
    fraction = (age - mid_end) / max(1.0, duration - mid_end)
    return kc_mid + fraction * (kc_end - kc_mid)


def crop_calendar_status(crop, month=None):
    month = month or date.today().month
    return month in CROP_DATA[crop]["planting_months"]


def estimated_daily_crop_water_litres(farmer, moisture=None):
    """Estimate gross daily irrigation requirement using the FAO-56 ETc method.

    ETc = Kc * ET0 (mm/day). Since 1 mm over 1 m² equals 1 litre,
    net crop water use is converted to litres using field area. Effective
    rainfall is subtracted and the result is divided by irrigation efficiency
    to estimate water that must be supplied at the source.

    `moisture` is intentionally not converted directly into a water volume:
    a percentage reading alone is insufficient without sensor calibration,
    field capacity, wilting point, and root-zone data. ET0 and rainfall defaults
    are configurable demo baselines, not live weather observations.
    """
    area_m2 = float(farmer["area_acres"]) * 4046.8564224
    et0 = max(0.0, float(CONFIG["reference_et0_mm_day"]))
    rainfall = max(0.0, float(CONFIG.get("effective_rainfall_mm_day", 0.0)))
    kc = crop_coefficient(farmer["crop"], farmer["crop_age_days"])
    efficiency = max(0.01, min(1.0, float(CONFIG["irrigation_efficiency"])))

    crop_et_mm_day = kc * et0
    net_irrigation_mm_day = max(0.0, crop_et_mm_day - rainfall)
    return (net_irrigation_mm_day * area_m2) / efficiency


def estimated_water_until_harvest_litres(farmer):
    """Estimate irrigation water from current crop age through expected harvest.

    Sums a daily ETc-based estimate across the remaining crop stages. This is
    an illustrative forecast using configured ET0/rainfall, not live weather.
    """
    duration = int(CROP_DATA[farmer["crop"]]["duration_days"])
    current_age = max(0, int(farmer["crop_age_days"]))
    if current_age >= duration:
        return 0.0

    total = 0.0
    forecast_farmer = dict(farmer)
    for age in range(current_age, duration):
        forecast_farmer["crop_age_days"] = age
        total += estimated_daily_crop_water_litres(forecast_farmer)
    return total


def register_farmer():
    print("\n--- FARMER REGISTRATION ---")

    farmer_id = input("Unique farmer ID (0 to cancel): ").strip()

    if farmer_id == "0":
        return

    if not farmer_id or any(
        f["id"].casefold() == farmer_id.casefold()
        for f in FARMERS
    ):
        print("ID is empty or already exists.")
        return

    name = input("Farmer name (0 to cancel): ").strip()

    if not name or name == "0":
        return

    crops = list(CROPS)

    print("\nAvailable crops:")
    for i, crop in enumerate(crops, 1):
        print(f"{i}. {crop}")

    crop_choice = ask_number(
        "Select crop number: ",
        minimum=1,
        maximum=len(crops),
        integer=True
    )

    if crop_choice is None:
        return

    crop = crops[crop_choice - 1]

    area = ask_number(
        "Farm area in acres: ",
        minimum=0.0001
    )

    if area is None:
        return

    dates = choose_crop_age()

    if dates is None:
        return

    age = dates["crop_age_days"]

    farmer = {
        "id": farmer_id,
        "name": name,
        "status": "active",
        "crop": crop,
        "area_acres": area,
        **dates,
        "crop_coefficient": crop_coefficient(crop, age),
        "last_soil_moisture": None,
        "total_allocated_litres": 0.0,
        "total_delivered_litres": 0.0,
        "epochs_served": 0
    }

    # Store estimates for one day and the remaining crop lifecycle.
    farmer["estimated_daily_water_litres"] = estimated_daily_crop_water_litres(farmer)
    farmer["estimated_water_until_harvest_litres"] = estimated_water_until_harvest_litres(farmer)

    FARMERS.append(farmer)
    save_farmers()

    print("\nFarmer registered.")
    print("Name:", name)
    print("Crop:", crop)
    print("Area:", area, "acres")
    print("Crop age:", age, "days")
    print("Reference crop coefficient (Kc):", round(farmer["crop_coefficient"], 3))
    print("Reference crop season:", CROP_DATA[crop]["season"])
    if not crop_calendar_status(crop):
        print("Calendar note: this month is outside the simplified TNAU-based planting window; check the local district calendar. Existing crops can still be registered.")


def edit_farmer(actor):
    """Edit an existing farmer's registration details and refresh estimates."""
    if not FARMERS:
        print("No farmers are registered.")
        return

    print("\\n--- EDIT FARMER DETAILS ---")
    print_table([
        {
            "ID": f["id"],
            "Name": f.get("name", ""),
            "Crop": f.get("crop", ""),
            "Area (acres)": f.get("area_acres", ""),
            "Age (days)": f.get("crop_age_days", ""),
            "Status": f.get("status", "active")
        }
        for f in FARMERS
    ])

    farmer_id = input("\\nEnter the exact farmer ID to edit (B to cancel): ").strip()
    if farmer_id.upper() == "B":
        print("Cancelled.")
        return

    farmer = next(
        (item for item in FARMERS if item["id"].casefold() == farmer_id.casefold()),
        None
    )
    if farmer is None:
        print("No farmer found with that ID.")
        return

    print("\\nPress Enter to keep a current value. Enter B at a prompt to cancel the entire edit.")
    print("Current name:", farmer.get("name", ""))
    name = input("New farmer name: ").strip()
    if name.upper() == "B":
        print("Edit cancelled.")
        return
    if name:
        farmer["name"] = name

    print("\\nAvailable crops:")
    for i, crop_name in enumerate(CROPS, 1):
        print(f"{i}. {crop_name}")
    print("Current crop:", farmer.get("crop", ""))
    crop_raw = input("New crop number (Enter to keep): ").strip()
    if crop_raw.upper() == "B":
        print("Edit cancelled.")
        return
    if crop_raw:
        try:
            crop_index = int(crop_raw)
            if not 1 <= crop_index <= len(CROPS):
                raise ValueError
            farmer["crop"] = CROPS[crop_index - 1]
        except ValueError:
            print("Invalid crop selection. Edit cancelled without saving.")
            return

    print("Current area (acres):", farmer.get("area_acres", ""))
    area_raw = input("New farm area in acres (Enter to keep): ").strip()
    if area_raw.upper() == "B":
        print("Edit cancelled.")
        return
    if area_raw:
        try:
            area = float(area_raw)
            if not math.isfinite(area) or area <= 0:
                raise ValueError
            farmer["area_acres"] = area
        except ValueError:
            print("Invalid area. Edit cancelled without saving.")
            return

    print("Current crop age (days):", farmer.get("crop_age_days", ""))
    age_raw = input("New crop age in days (Enter to keep): ").strip()
    if age_raw.upper() == "B":
        print("Edit cancelled.")
        return
    if age_raw:
        try:
            age = int(age_raw)
            if age < 0 or age > 3650:
                raise ValueError
            current = date.today()
            planted = current - timedelta(days=age)
            farmer["crop_age_days"] = age
            farmer["current_date"] = current.isoformat()
            farmer["planting_date"] = planted.isoformat()
        except ValueError:
            print("Invalid crop age. Edit cancelled without saving.")
            return

    # Refresh the crop coefficient and the two estimates after any changes.
    farmer["crop_coefficient"] = crop_coefficient(
        farmer["crop"], farmer["crop_age_days"]
    )
    farmer["estimated_daily_water_litres"] = estimated_daily_crop_water_litres(farmer)
    farmer["estimated_water_until_harvest_litres"] = estimated_water_until_harvest_litres(farmer)

    save_farmers()
    audit(actor, f"Edited farmer ID {farmer['id']} ({farmer['name']})")
    print("\\nFarmer details updated and saved.")
    print("Updated crop coefficient:", round(farmer["crop_coefficient"], 3))
    print("Daily water estimate (L/day):", round(farmer["estimated_daily_water_litres"], 2))
    print("Expected water till harvest (L):", round(farmer["estimated_water_until_harvest_litres"], 2))


def view_farmers():
    rows = []

    for farmer in FARMERS:
        rows.append({
            "ID": farmer["id"],
            "Name": farmer["name"],
            "Crop": farmer["crop"],
            "Area (acres)": round(farmer["area_acres"], 2),
            "Age (days)": farmer["crop_age_days"],
            "Daily water estimate (L/day)": round(estimated_daily_crop_water_litres(farmer), 2),
            "Expected water till harvest (L)": round(estimated_water_until_harvest_litres(farmer), 2)
        })

    print_table(rows)



def deactivate_farmer(actor):
    """Deactivate a farmer while retaining the saved record and its history."""
    active = [f for f in FARMERS if f.get("status", "active") == "active"]
    if not active:
        print("No active farmers to deactivate.")
        return

    print("\n--- DEACTIVATE FARMER ---")
    print_table([
        {"ID": f["id"], "Name": f["name"], "Crop": f["crop"], "Status": "active"}
        for f in active
    ])
    farmer_id = input("\nEnter exact farmer ID (B to cancel): ").strip()
    if farmer_id.upper() == "B":
        print("Cancelled.")
        return

    farmer = next((f for f in active if f["id"].casefold() == farmer_id.casefold()), None)
    if farmer is None:
        print("No active farmer found with that ID.")
        return

    if input(f"Type DEACTIVATE to deactivate {farmer['name']}: ").strip() != "DEACTIVATE":
        print("Cancelled. No data was changed.")
        return

    farmer["status"] = "inactive"
    farmer["deactivated_at"] = datetime.now().isoformat(timespec="seconds")
    save_farmers()
    audit(actor, f"Deactivated farmer ID {farmer['id']} ({farmer['name']}); record retained")
    print("Farmer deactivated; saved record retained.")


def reactivate_farmer(actor):
    inactive = [f for f in FARMERS if f.get("status") == "inactive"]
    if not inactive:
        print("No inactive farmers to reactivate.")
        return

    print("\n--- REACTIVATE FARMER ---")
    print_table([{"ID": f["id"], "Name": f["name"], "Status": "inactive"} for f in inactive])
    farmer_id = input("\nEnter exact farmer ID (B to cancel): ").strip()
    if farmer_id.upper() == "B":
        return

    farmer = next((f for f in inactive if f["id"].casefold() == farmer_id.casefold()), None)
    if farmer is None:
        print("No inactive farmer found with that ID.")
        return

    if input(f"Type REACTIVATE to restore {farmer['name']}: ").strip() != "REACTIVATE":
        print("Cancelled.")
        return

    farmer["status"] = "active"
    farmer.pop("deactivated_at", None)
    save_farmers()
    audit(actor, f"Reactivated farmer ID {farmer['id']} ({farmer['name']})")
    print("Farmer reactivated.")



def delete_farmer():
    """Delete one farmer after explicit confirmation; persist and audit the change."""
    if not FARMERS:
        print("No farmers are registered.")
        return

    print("\n--- DELETE FARMER ---")
    view_farmers()
    farmer_id = input("\nEnter the exact farmer ID to delete (B to cancel): ").strip()

    if farmer_id.upper() == "B":
        print("Deletion cancelled.")
        return

    farmer = next(
        (item for item in FARMERS if item["id"].casefold() == farmer_id.casefold()),
        None
    )

    if farmer is None:
        print("No farmer found with that ID.")
        return

    print(f"Selected: {farmer['name']} | {farmer['crop']} | {farmer['area_acres']} acres")
    confirm = input("Type DELETE to permanently remove this farmer's saved record: ").strip()

    if confirm != "DELETE":
        print("Deletion cancelled. No data was changed.")
        return

    FARMERS.remove(farmer)
    save_farmers()
    audit("farmer-mode", f"Deleted farmer ID {farmer['id']} ({farmer['name']})")
    print(f"Farmer {farmer['name']} (ID: {farmer['id']}) deleted successfully.")


# ======================== DEMAND MODEL ===========================

def simulated_soil_moisture(farmer, rng):
    # Synthetic reading. Replace with sensor input for hardware use.
    value = rng.uniform(25.0, 75.0)
    value += rng.gauss(0, float(CONFIG["soil_sensor_noise"]))
    return max(0.0, min(100.0, value))


def estimate_demand(farmer, moisture):
    # ETc-based daily gross irrigation estimate. Soil moisture is displayed as
    # a sensor reading but is not converted to litres without soil calibration.
    return estimated_daily_crop_water_litres(farmer, moisture)


def update_planning_budget(farmer, forecast_litres=None):
    """Refresh informational estimates; these do not affect allocation."""
    farmer["estimated_daily_water_litres"] = estimated_daily_crop_water_litres(farmer)
    farmer["estimated_water_until_harvest_litres"] = estimated_water_until_harvest_litres(farmer)


def jain_index(values):
    values = [max(0.0, float(v)) for v in values]

    if not values or sum(v * v for v in values) == 0:
        return 1.0

    return sum(values) ** 2 / (
        len(values) * sum(v * v for v in values)
    )


# ======================== ALLOCATION METHODS =====================

def allocate_fcfs(demands, water):
    """Registration-order allocation."""
    allocations = [0.0] * len(demands)
    remaining = max(0.0, water)

    for i, demand in enumerate(demands):
        amount = min(demand, remaining)
        allocations[i] = amount
        remaining -= amount

    return allocations


def capped_weighted_allocation(demands, priorities, water):
    """
    General capped weighted allocation.

    Allocates in proportion to priorities while:
    - never allocating more than a farmer's demand
    - never exceeding the total available water
    """
    demands = [max(0.0, float(d)) for d in demands]
    priorities = [max(0.0, float(p)) for p in priorities]
    water = max(0.0, float(water))

    if not demands:
        return []

    if water <= 0:
        return [0.0] * len(demands)

    if water >= sum(demands):
        return demands[:]

    allocations = [0.0] * len(demands)
    active = {
        i for i, demand in enumerate(demands)
        if demand > 0 and priorities[i] > 0
    }
    remaining = water

    while active and remaining > 1e-9:
        total_priority = sum(priorities[i] for i in active)

        if total_priority <= 0:
            break

        proposed = {
            i: remaining * priorities[i] / total_priority
            for i in active
        }

        capped = [
            i for i in active
            if proposed[i] >= demands[i] - allocations[i]
        ]

        if not capped:
            for i in active:
                allocations[i] += proposed[i]
            remaining = 0.0
            break

        # Satisfy capped farmers first, then redistribute leftover water.
        for i in capped:
            room = demands[i] - allocations[i]
            allocations[i] += room
            remaining -= room
            active.remove(i)

    # Floating-point safety.
    allocations = [
        min(demands[i], max(0.0, allocations[i]))
        for i in range(len(demands))
    ]

    return allocations


def allocate_equal(demands, water):
    """Equal amounts, with each allocation capped at demand."""
    return capped_weighted_allocation(
        demands,
        [1.0] * len(demands),
        water
    )


def allocate_need_proportional(demands, water):
    """Allocation proportional to estimated water demand."""
    return capped_weighted_allocation(
        demands,
        demands,
        water
    )


def allocate_weighted_nash(demands, water):
    """Need-weighted Nash bargaining using demand as bargaining weight.

    Solves max sum(demand_i * log(allocation_i)) subject to:
    0 <= allocation_i <= demand_i and sum(allocation_i) <= water.
    The capped water-filling solution is allocation_i = min(demand_i,
    demand_i / mu). No historical fairness credits are used.
    """
    return capped_weighted_allocation(demands, demands, water)


STRATEGIES = [
    "FCFS",
    "Equal Allocation",
    "Need-Proportional",
    "Need-Weighted Nash Bargaining"
]


def run_strategy(strategy, demands, water):
    if strategy == "FCFS":
        return allocate_fcfs(demands, water)
    if strategy == "Equal Allocation":
        return allocate_equal(demands, water)
    if strategy == "Need-Proportional":
        return allocate_need_proportional(demands, water)
    if strategy == "Need-Weighted Nash Bargaining":
        return allocate_weighted_nash(demands, water)
    raise ValueError("Unknown strategy: " + strategy)


# ======================== METRICS ================================

def get_metrics(demands, allocations):
    satisfaction = [
        min(1.0, a / d) if d > 1e-9 else 1.0
        for d, a in zip(demands, allocations)
    ]

    average_satisfaction = (
        100.0 * sum(satisfaction) / len(satisfaction)
        if satisfaction else 100.0
    )

    return {
        "allocated": sum(allocations),
        "unmet": sum(
            max(0.0, d - a)
            for d, a in zip(demands, allocations)
        ),
        "allocation_fairness": jain_index(allocations),
        "satisfaction_fairness": jain_index(satisfaction),
        "average_satisfaction": average_satisfaction,
        "satisfaction": satisfaction
    }


# ======================== STRATEGY COMPARISON ====================

def compare_strategies():
    active_farmers = [f for f in FARMERS if f.get("status", "active") == "active"]
    if not active_farmers:
        print("No active farmers are registered.")
        return

    water = ask_number(
        "Available water in litres (B to go back): ",
        minimum=0
    )

    if water is None:
        return

    # Generate ONE fixed set of readings and reuse it for every method.
    rng = random.Random(int(CONFIG["random_seed"]))

    moisture = [
        simulated_soil_moisture(farmer, rng)
        for farmer in active_farmers
    ]

    demands = [
        estimate_demand(farmer, m)
        for farmer, m in zip(active_farmers, moisture)
    ]


    results = {}

    for strategy in STRATEGIES:
        results[strategy] = run_strategy(strategy, demands, water)

    print("\n" + "=" * 105)
    print("IRRIGATION STRATEGY COMPARISON")
    print("=" * 105)
    print("ACTIVE PROJECT METHOD:", ACTIVE_STRATEGY)
    print(f"Available water: {water:.2f} L")
    print(f"Total estimated demand: {sum(demands):.2f} L")
    print("All methods use the SAME sensor readings and demand estimates.")

    print("\n--- INPUT DATA ---")

    input_rows = []

    for i, farmer in enumerate(active_farmers):
        input_rows.append({
            "Farmer": farmer["name"],
            "Crop": farmer["crop"],
            "Area (acres)": round(farmer["area_acres"], 2),
            "Soil moisture (%)": round(moisture[i], 2),
            "Demand (L)": round(demands[i], 2)
        })

    print_table(input_rows)

    print("\n--- ALLOCATION PER FARMER ---")

    allocation_rows = []

    for i, farmer in enumerate(active_farmers):
        row = {"Farmer": farmer["name"]}

        for strategy in STRATEGIES:
            label = strategy
            if strategy == ACTIVE_STRATEGY:
                label += " [OUR METHOD]"

            row[label] = round(results[strategy][i], 2)

        allocation_rows.append(row)

    print_table(allocation_rows)

    print("\n--- PERFORMANCE COMPARISON ---")

    performance_rows = []

    for strategy in STRATEGIES:
        metrics = get_metrics(demands, results[strategy])

        performance_rows.append({
            "Strategy": strategy,
            "Role": (
                "OUR METHOD"
                if strategy == ACTIVE_STRATEGY
                else "Benchmark"
            ),
            "Allocated (L)": round(metrics["allocated"], 2),
            "Unmet demand (L)": round(metrics["unmet"], 2),
            "Allocation fairness": round(
                metrics["allocation_fairness"], 4
            ),
            "Satisfaction fairness": round(
                metrics["satisfaction_fairness"], 4
            ),
            "Avg satisfaction (%)": round(
                metrics["average_satisfaction"], 2
            )
        })

    print_table(performance_rows)

    print("\n--- WHAT EACH METHOD DOES ---")
    print("FCFS: registration order determines who receives water first.")
    print("Equal Allocation: aims for equal water amounts.")
    print("Need-Proportional: allocates according to estimated demand.")
    print("Need-Weighted Nash Bargaining [OUR METHOD]: maximizes the demand-weighted log utility under demand and supply constraints.")

    print("\nInterpretation:")
    print("- Higher satisfaction fairness means more balanced satisfaction.")
    print("- Lower unmet demand means less estimated demand remains unserved.")
    print("- The fairest result is not automatically the most need-responsive.")
    print("- Compare all metrics rather than declaring a winner from one metric.")


# ======================== NORMAL IRRIGATION =======================

def run_irrigation():
    active_farmers = [f for f in FARMERS if f.get("status", "active") == "active"]
    if not active_farmers:
        print("No active farmers are registered.")
        return

    water = ask_number(
        "Available water in litres (B to go back): ",
        minimum=0
    )

    if water is None:
        return

    rng = random.Random(int(CONFIG["random_seed"]))

    moisture = [
        simulated_soil_moisture(farmer, rng)
        for farmer in active_farmers
    ]

    demands = [
        estimate_demand(farmer, m)
        for farmer, m in zip(active_farmers, moisture)
    ]


    allocations = run_strategy(
        ACTIVE_STRATEGY, demands, water
    )

    # Simulated flow-meter readings, not real sensor measurements.
    delivered = []

    for amount in allocations:
        noise = rng.uniform(
            -float(CONFIG["flow_sensor_noise"]),
            float(CONFIG["flow_sensor_noise"])
        )
        delivered.append(max(0.0, amount * (1 + noise)))

    rows = []

    for i, farmer in enumerate(active_farmers):
        satisfaction = (
            min(1.0, delivered[i] / demands[i])
            if demands[i] > 1e-9 else 1.0
        )

        rows.append({
            "Farmer": farmer["name"],
            "Demand (L)": round(demands[i], 2),
            "Allocated (L)": round(allocations[i], 2),
            "Simulated delivered (L)": round(delivered[i], 2),
            "Satisfied (%)": round(satisfaction * 100, 2)
        })

        farmer["last_soil_moisture"] = round(moisture[i], 2)
        farmer["total_allocated_litres"] += allocations[i]
        farmer["total_delivered_litres"] += delivered[i]
        farmer["epochs_served"] += 1
        update_planning_budget(farmer)

    # Planning budget is tracking-only and never changes allocation priority.
    save_farmers()

    metrics = get_metrics(demands, allocations)

    print("\nACTIVE STRATEGY:", ACTIVE_STRATEGY)
    print(f"Available water: {water:.2f} L")
    print_table(rows)

    print(f"\nTotal demand: {sum(demands):.2f} L")
    print(f"Total allocated: {sum(allocations):.2f} L")
    print(f"Simulated delivered: {sum(delivered):.2f} L")
    print(f"Unmet demand: {metrics['unmet']:.2f} L")
    print(f"Allocation fairness: {metrics['allocation_fairness']:.4f}")
    print(f"Satisfaction fairness: {metrics['satisfaction_fairness']:.4f}")
    print(f"Average satisfaction: {metrics['average_satisfaction']:.2f}%")

    try:
        schedule, duration, fits = create_schedule(allocations)

        print("\n--- VALVE SCHEDULE ---")
        print_table(schedule)
        print(f"Total duration: {duration:.2f} minutes")
        print(
            "Fits operating window:",
            "YES" if fits else "NO - adjust water/window"
        )

    except ValueError as exc:
        print("Scheduling warning:", exc)

    print(
        "Water constraint:",
        "PASS" if sum(allocations) <= water + 1e-6 else "FAIL"
    )


# ======================== HYDRAULIC SCHEDULER ====================

def create_schedule(allocations):
    pipe = float(CONFIG["pipe_capacity_lpm"])
    flow = float(CONFIG["valve_flow_lpm"])
    window = float(CONFIG["operating_window_minutes"])

    if pipe <= 0 or flow <= 0 or window <= 0:
        raise ValueError("Pipe, valve flow and window must be positive.")

    if flow > pipe:
        raise ValueError("Valve flow exceeds pipe capacity.")

    rows = []
    elapsed = 0.0

    for farmer, amount in zip(active_farmers, allocations):
        if amount <= 1e-9:
            continue

        duration = amount / flow

        rows.append({
            "Farmer": farmer["name"],
            "Valve": "Valve-" + farmer["id"],
            "Allocated (L)": round(amount, 2),
            "Flow (L/min)": round(flow, 2),
            "Start (min)": round(elapsed, 2),
            "End (min)": round(elapsed + duration, 2)
        })

        elapsed += duration

    return rows, elapsed, elapsed <= window


# ======================== MULTI-EPOCH TEST =======================

def multi_epoch_simulation():
    """Run scarcity epochs and report demand/allocation/shortage per farmer."""
    active_farmers = [
        f for f in FARMERS if f.get("status", "active") == "active"
    ]
    if not active_farmers:
        print("No active farmers are registered.")
        return

    epochs = ask_number(
        "Number of epochs (1-100, B to go back): ",
        minimum=1, maximum=100, integer=True
    )
    if epochs is None:
        return

    normal_water = ask_number(
        "Normal water supply (L per epoch): ", minimum=0
    )
    if normal_water is None:
        return

    scarce_water = ask_number(
        "Scarcity water supply (L per epoch): ", minimum=0
    )
    if scarce_water is None:
        return

    start = ask_number(
        "Scarcity begins at epoch: ",
        minimum=1, maximum=epochs, integer=True
    )
    if start is None:
        return

    epoch_rows = []
    farmer_totals = {
        farmer["id"]: {
            "Farmer ID": farmer["id"],
            "Farmer": farmer.get("name", "Unknown"),
            "Crop": farmer.get("crop", "Unknown"),
            "Total demand (L)": 0.0,
            "Total allocated (L)": 0.0,
            "Total shortage (L)": 0.0,
        }
        for farmer in active_farmers
    }
    base_seed = int(CONFIG["random_seed"])

    for epoch in range(1, int(epochs) + 1):
        supply = normal_water if epoch < start else scarce_water
        rng = random.Random(base_seed + epoch)

        moisture = [
            simulated_soil_moisture(farmer, rng)
            for farmer in active_farmers
        ]
        demands = [
            max(0.0, float(estimate_demand(farmer, m)))
            for farmer, m in zip(active_farmers, moisture)
        ]
        allocations = run_strategy(ACTIVE_STRATEGY, demands, supply)
        metrics = get_metrics(demands, allocations)

        epoch_rows.append({
            "Epoch": epoch,
            "Water regime": "Normal" if epoch < start else "Scarcity",
            "Supply (L)": round(supply, 2),
            "Total demand (L)": round(sum(demands), 2),
            "Total allocated (L)": round(sum(allocations), 2),
            "Total shortage (L)": round(metrics["unmet"], 2),
            "Average satisfaction (%)": round(
                metrics["average_satisfaction"], 2
            ),
        })

        print(f"\\n--- EPOCH {epoch} | "
              f"{'NORMAL SUPPLY' if epoch < start else 'SCARCITY'} ---")
        print(f"Available water: {supply:.2f} L | "
              f"Allocation strategy: {ACTIVE_STRATEGY}")
        farmer_rows = []
        for farmer, demand, allocation in zip(
            active_farmers, demands, allocations
        ):
            shortage = max(0.0, demand - allocation)
            satisfaction = (
                100.0 * allocation / demand if demand > 0 else 100.0
            )
            farmer_rows.append({
                "Farmer ID": farmer["id"],
                "Farmer": farmer.get("name", "Unknown"),
                "Crop": farmer.get("crop", "Unknown"),
                "Demand (L)": round(demand, 2),
                "Allocated (L)": round(allocation, 2),
                "Shortage (L)": round(shortage, 2),
                "Demand met (%)": round(satisfaction, 2),
            })

            totals = farmer_totals[farmer["id"]]
            totals["Total demand (L)"] += demand
            totals["Total allocated (L)"] += allocation
            totals["Total shortage (L)"] += shortage

        print_table(farmer_rows)
        print(
            f"Epoch total — demand: {sum(demands):.2f} L | "
            f"allocated: {sum(allocations):.2f} L | "
            f"shortage: {metrics['unmet']:.2f} L"
        )

    print("\\n=== EPOCH SUMMARY ===")
    print_table(epoch_rows)

    summary_rows = []
    for totals in farmer_totals.values():
        demand_total = totals["Total demand (L)"]
        allocated_total = totals["Total allocated (L)"]
        totals["Demand met (%)"] = round(
            100.0 * allocated_total / demand_total
            if demand_total > 0 else 100.0, 2
        )
        summary_rows.append({
            "Farmer ID": totals["Farmer ID"],
            "Farmer": totals["Farmer"],
            "Crop": totals["Crop"],
            "Total demand (L)": round(demand_total, 2),
            "Total allocated (L)": round(allocated_total, 2),
            "Total shortage (L)": round(totals["Total shortage (L)"], 2),
            "Demand met (%)": totals["Demand met (%)"],
        })

    print("\\n=== FARMER-WISE SUMMARY ACROSS ALL EPOCHS ===")
    print_table(summary_rows)
    print("\\nNote: 'Allocated' is the amount assigned by the selected allocation "
          "strategy. This simulation does not independently measure physical "
          "valve delivery.")


# ======================== CONFIGURATION ==========================

def valid_config(config):
    for key in (
        "pipe_capacity_lpm",
        "valve_flow_lpm",
        "operating_window_minutes",
        "reference_et0_mm_day",
        "effective_rainfall_mm_day",
        "irrigation_efficiency"
    ):
        if not math.isfinite(float(config[key])) or config[key] <= 0:
            return False, key + " must be positive."

    if config["valve_flow_lpm"] > config["pipe_capacity_lpm"]:
        return False, "Valve flow cannot exceed pipe capacity."

    if not 0 < config["target_moisture"] <= 100:
        return False, "Target moisture must be greater than 0 and at most 100."

    if not 0.5 <= config["reference_et0_mm_day"] <= 15:
        return False, "Reference ET0 must be between 0.5 and 15 mm/day."

    if not 0 <= config.get("effective_rainfall_mm_day", 0.0) <= 200:
        return False, "Effective rainfall must be between 0 and 200 mm/day."

    if not 0.1 <= config["irrigation_efficiency"] <= 1.0:
        return False, "Irrigation efficiency must be between 0.1 and 1.0."

    if not 0 <= config["soil_sensor_noise"] <= 20:
        return False, "Soil sensor noise must be between 0 and 20."

    if not 0 <= config["flow_sensor_noise"] <= 0.5:
        return False, "Flow sensor noise must be between 0 and 0.5."

    return True, ""


def edit_config(username):
    global CONFIG
    working = CONFIG.copy()

    fields = [
        ("pipe_capacity_lpm", "Pipe capacity L/min"),
        ("valve_flow_lpm", "Valve flow L/min"),
        ("operating_window_minutes", "Operating window minutes"),
        ("soil_sensor_noise", "Soil sensor noise"),
        ("flow_sensor_noise", "Flow sensor noise fraction"),
        ("target_moisture", "Target moisture percentage"),
        ("reference_et0_mm_day", "Reference ET0 (mm/day)"),
        ("effective_rainfall_mm_day", "Effective rainfall (mm/day)"),
        ("irrigation_efficiency", "Irrigation efficiency (0-1)"),
        ("random_seed", "Random seed")
    ]

    while True:
        print("\n--- ADMIN CONFIGURATION ---")

        for i, (key, label) in enumerate(fields, 1):
            print(f"{i}. {label}: {working[key]}")

        print("S. Validate and save")
        print("0. Cancel without saving")

        choice = input("Choose: ").strip().lower()

        if choice == "0":
            print("Changes cancelled.")
            return

        if choice == "s":
            ok, message = valid_config(working)

            if not ok:
                print("Invalid configuration:", message)
                continue

            save_json(CONFIG_FILE, working)
            CONFIG = working
            audit(username, "Updated configuration")
            print("Configuration saved.")
            return

        if not choice.isdigit() or not 1 <= int(choice) <= len(fields):
            print("Invalid choice.")
            continue

        key, label = fields[int(choice) - 1]
        raw = input(f"New value for {label} (B to cancel): ").strip()

        if raw.upper() == "B":
            continue

        try:
            value = int(raw) if key == "random_seed" else float(raw)

            if not math.isfinite(float(value)):
                raise ValueError

            working[key] = value

        except ValueError:
            print("Enter a valid number.")


# ======================== MENUS ==================================

def farmer_menu():
    """Read-only farmer view for this command-line prototype."""
    while True:
        print("\n========== FARMER MODE ==========")
        print("1. View registered farmer records")
        print("0. Back")
        choice = input("Choose: ").strip()

        if choice == "1":
            view_farmers()
        elif choice == "0":
            return
        else:
            print("Invalid choice.")



def admin_menu():
    username = admin_login()
    if username is None:
        print("Admin login cancelled or failed.")
        return

    while True:
        print("\n========== ADMIN / COORDINATOR ==========")
        print("1. Register farmer")
        print("2. View all farmer records")
        print("3. Edit farmer details")
        print("4. Edit configuration")
        print("5. Run multi-epoch scarcity simulation")
        print("6. Compare allocation strategies")
        print("7. Deactivate farmer")
        print("8. Reactivate farmer")
        print("9. View audit log")
        print("10. Change admin credentials")
        print("0. Logout")
        choice = input("Choose: ").strip()

        if choice == "1":
            register_farmer()
        elif choice == "2":
            view_farmers()
        elif choice == "3":
            edit_farmer(username)
        elif choice == "4":
            edit_config(username)
        elif choice == "5":
            multi_epoch_simulation()
        elif choice == "6":
            compare_strategies()
        elif choice == "7":
            deactivate_farmer(username)
        elif choice == "8":
            reactivate_farmer(username)
        elif choice == "10":
            username = change_admin_credentials(username)
        elif choice == "9":
            if AUDIT_FILE.exists():
                print(AUDIT_FILE.read_text(encoding="utf-8"))
            else:
                print("No audit log yet.")
        elif choice == "0":
            audit(username, "Logout")
            return
        else:
            print("Invalid choice.")


# ======================== MAIN PROGRAM ===========================

def main():
    print("=" * 76)
    print("SOLAR-POWERED ADAPTIVE IRRIGATION SIMULATOR")
    print("=" * 76)
    print("ACTIVE METHOD:", ACTIVE_STRATEGY)
    print("Sensor readings are simulated.")
    print("Crop Kc references: FAO-56; simplified planting calendar: TNAU regional crop patterns.")
    print("ET0 uses a configurable baseline (default 5 mm/day), not live weather data.")
    print("Soil moisture and flow readings are simulated unless connected to real sensors.")
    print("Fairness credits are disabled. Water values are estimates, not live measurements.")

    while True:
        print("\n=============== MAIN MENU ===============")
        print("1. Farmer mode")
        print("2. Admin / simulation mode")
        print("0. Exit")

        choice = input("Choose: ").strip()

        if choice == "1":
            farmer_menu()
        elif choice == "2":
            admin_menu()
        elif choice == "0":
            print("Simulator ended.")
            break
        else:
            print("Invalid choice.")


try:
    main()
except (KeyboardInterrupt, EOFError):
    print("\nSimulator stopped safely.")
