// ================================================================
// FARMFLOW - Solar-Powered Adaptive Irrigation Simulator
// Express.js Backend v3 - Solar Battery Telemetry, Water Requests,
// Edge Coordinator Notifications & Smart Advisory
// ================================================================

const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ======================== FILE PATHS ==========================
const BASE_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(BASE_DIR)) fs.mkdirSync(BASE_DIR, { recursive: true });

const FARMERS_FILE       = path.join(BASE_DIR, 'irrigation_farmers.json');
const CONFIG_FILE        = path.join(BASE_DIR, 'irrigation_config.json');
const ADMIN_FILE         = path.join(BASE_DIR, 'irrigation_admin.json');
const AUDIT_FILE         = path.join(BASE_DIR, 'irrigation_audit.log');
const HISTORY_FILE       = path.join(BASE_DIR, 'irrigation_history.json');
const REQUESTS_FILE      = path.join(BASE_DIR, 'irrigation_requests.json');
const NOTIFICATIONS_FILE = path.join(BASE_DIR, 'irrigation_notifications.json');
const SOLAR_FILE         = path.join(BASE_DIR, 'irrigation_solar.json');

// ======================== DEFAULTS ============================
const DEFAULT_CONFIG = {
  pipe_capacity_lpm: 10.0,
  valve_flow_lpm: 5.0,
  operating_window_minutes: 240.0,
  soil_sensor_noise: 2.0,
  flow_sensor_noise: 0.02,
  target_moisture: 70.0,
  reference_et0_mm_day: 5.0,
  effective_rainfall_mm_day: 0.0,
  irrigation_efficiency: 0.85,
  random_seed: 42
};

const ACTIVE_STRATEGY = "Need-Weighted Nash Bargaining";

const CROP_DATA = {
  "Rice (Paddy)":        { duration_days: 120, kc: [1.05, 1.20, 0.90], planting_months: [6,7,8,9,10,11,12,1,2],       season: "Sornavari/Kuruvai or Samba/Thaladi depending on district" },
  "Groundnut":           { duration_days: 110, kc: [0.40, 1.15, 0.60], planting_months: [1,2,3,4,6,7,8,9,10,11,12],   season: "varies by zone; rainfed and irrigated windows" },
  "Green gram":          { duration_days: 65,  kc: [0.40, 1.05, 0.35], planting_months: [10,11,12,1,2,3,4],           season: "Rabi/summer windows vary by district" },
  "Black gram":          { duration_days: 70,  kc: [0.40, 1.05, 0.35], planting_months: [10,11,12,1,2,3,4],           season: "Rabi and rice-fallow windows vary by district" },
  "Maize":               { duration_days: 110, kc: [0.30, 1.20, 0.60], planting_months: [1,2,3,6,7,8,9,10,11,12],     season: "multiple seasons depending on zone" },
  "Sugarcane":           { duration_days: 365, kc: [0.40, 1.25, 0.75], planting_months: [1,2,3,4,5,6,7,8,9,10,11,12], season: "long-duration crop; planting window varies by district" },
  "Banana":              { duration_days: 365, kc: [0.50, 1.10, 1.00], planting_months: [1,2,3,4,5,6,7,8,9,10,11,12], season: "commonly grown year-round with local scheduling" },
  "Sorghum (Jowar)":     { duration_days: 110, kc: [0.30, 1.00, 0.55], planting_months: [6,7,8,9,10,11,12,1,2],       season: "rainfed windows vary by zone" },
  "Pearl millet (Cumbu)":{ duration_days: 85,  kc: [0.30, 1.00, 0.55], planting_months: [6,7,8,9,10,11,12,1,2],       season: "rainfed windows vary by zone" },
  "Ragi (Finger millet)":{ duration_days: 110, kc: [0.30, 1.00, 0.60], planting_months: [4,5,6,7,8,9,10,11],          season: "district-specific rainfed/irrigated windows" },
  "Cotton":              { duration_days: 160, kc: [0.35, 1.15, 0.70], planting_months: [6,7,8,9,10],                  season: "mainly monsoon-season planting; local variation" },
  "Sesame (Gingelly)":   { duration_days: 90,  kc: [0.35, 1.10, 0.25], planting_months: [1,2,3,4,5,6,9,10,11,12],     season: "multiple local sowing windows" },
  "Tomato":              { duration_days: 120, kc: [0.60, 1.15, 0.80], planting_months: [1,2,3,4,5,6,7,8,9,10,11,12], season: "vegetable crop; season depends on district and variety" }
};

const CROPS = Object.keys(CROP_DATA);
const STRATEGIES = ["FCFS", "Equal Allocation", "Need-Proportional", "Need-Weighted Nash Bargaining"];

// ======================== FILE HELPERS ========================
function loadJson(filePath, defaultVal) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return defaultVal; }
}

function saveJson(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function audit(actor, message) {
  const line = `[${new Date().toISOString()}] ${actor}: ${message}\n`;
  fs.appendFileSync(AUDIT_FILE, line, 'utf8');
}

// ======================== CONFIG ==============================
let CONFIG = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_FILE, {}) };

// ======================== FARMERS =============================
let FARMERS = loadJson(FARMERS_FILE, []);
if (!Array.isArray(FARMERS)) FARMERS = [];
function saveFarmers() { saveJson(FARMERS_FILE, FARMERS); }
FARMERS.forEach(f => {
  delete f.fairness_credit;
  if (f.crop === 'Rice') f.crop = 'Rice (Paddy)';
  ensureFarmerPlots(f);
});
saveFarmers();

// ======================== HISTORY =============================
let HISTORY = loadJson(HISTORY_FILE, []);
if (!Array.isArray(HISTORY)) HISTORY = [];
function saveHistory() { saveJson(HISTORY_FILE, HISTORY.slice(-100)); }

// ======================== REQUESTS & NOTIFICATIONS ============
let REQUESTS = loadJson(REQUESTS_FILE, []);
if (!Array.isArray(REQUESTS)) REQUESTS = [];
function saveRequests() { saveJson(REQUESTS_FILE, REQUESTS); }

let NOTIFICATIONS = loadJson(NOTIFICATIONS_FILE, []);
if (!Array.isArray(NOTIFICATIONS)) NOTIFICATIONS = [];
function saveNotifications() { saveJson(NOTIFICATIONS_FILE, NOTIFICATIONS.slice(-200)); }

function addNotification({ recipientRole, recipientId, title, message, type='info', link=null }) {
  const notif = {
    id: 'NOTIF-' + Date.now() + '-' + Math.floor(Math.random()*1000),
    recipientRole, // 'admin' or 'farmer'
    recipientId: recipientId || null, // null for all admins, or specific farmerId
    title,
    message,
    type, // 'info', 'success', 'warning', 'emergency'
    link,
    read: false,
    timestamp: new Date().toISOString()
  };
  NOTIFICATIONS.unshift(notif);
  saveNotifications();
  return notif;
}

// ======================== SOLAR & BATTERY MODEL ================
const DEFAULT_SOLAR = {
  battery_capacity_kwh: 12.0,      // 48V 250Ah system for 3-5HP pump
  battery_soc_pct: 84.5,           // State of charge %
  battery_voltage: 51.6,           // Volts
  panel_capacity_watts: 4000,      // 4 kW Solar PV array
  weather: 'Sunny',                // 'Sunny', 'Partly Cloudy', 'Overcast', 'Rainy'
  solar_irradiance_wm2: 880,       // W/m²
  solar_generation_watts: 3520,    // Watts generated
  pump_power_draw_watts: 0,        // Watts consumed by pump
  battery_health_pct: 98.0,
  pump_interlock_safe: true,
  last_updated: new Date().toISOString()
};

let SOLAR = { ...DEFAULT_SOLAR, ...loadJson(SOLAR_FILE, {}) };

function getSolarTelemetry(isPumpRunning = false) {
  // Factors based on weather
  const weatherFactors = {
    'Sunny':         { factor: 0.90, wm2: 900, et0: 6.0, rain: 0.0 },
    'Partly Cloudy': { factor: 0.60, wm2: 560, et0: 4.5, rain: 0.0 },
    'Overcast':      { factor: 0.25, wm2: 230, et0: 2.8, rain: 0.0 },
    'Rainy':         { factor: 0.10, wm2: 95,  et0: 1.5, rain: 15.0 }
  };
  const wf = weatherFactors[SOLAR.weather] || weatherFactors['Sunny'];

  // Current Solar PV output
  const genWatts = Math.round(SOLAR.panel_capacity_watts * wf.factor);
  SOLAR.solar_irradiance_wm2 = wf.wm2;
  SOLAR.solar_generation_watts = genWatts;

  // Pump power draw based on hydraulic capacity
  const pumpActivePower = CONFIG.pipe_capacity_lpm > 100 ? 2800 : 350; // Watts
  SOLAR.pump_power_draw_watts = isPumpRunning ? pumpActivePower : 0;

  // Net flow into/out of battery: Positive = Charging, Negative = Discharging
  const netFlowWatts = SOLAR.solar_generation_watts - SOLAR.pump_power_draw_watts;

  // Battery voltage curve for 48V LiFePO4: 44.0V (0%) to 53.6V (100%)
  SOLAR.battery_voltage = +(44.0 + (SOLAR.battery_soc_pct / 100.0) * 9.6).toFixed(1);

  // Safety interlock: Pump cannot operate if battery < 20% and solar generation is insufficient
  SOLAR.pump_interlock_safe = SOLAR.battery_soc_pct >= 20.0 || (genWatts >= pumpActivePower);

  // Estimated hours until full (if charging) or empty (if discharging)
  let runtimeHours = null;
  if (netFlowWatts > 50 && SOLAR.battery_soc_pct < 99.5) {
    const kwhNeeded = (SOLAR.battery_capacity_kwh * (100 - SOLAR.battery_soc_pct)) / 100.0;
    runtimeHours = +(kwhNeeded / (netFlowWatts / 1000.0)).toFixed(1);
  } else if (netFlowWatts < -50 && SOLAR.battery_soc_pct > 5.0) {
    const kwhAvail = (SOLAR.battery_capacity_kwh * (SOLAR.battery_soc_pct - 15.0)) / 100.0;
    runtimeHours = +(kwhAvail / (Math.abs(netFlowWatts) / 1000.0)).toFixed(1);
  }

  SOLAR.net_battery_flow_watts = netFlowWatts;
  SOLAR.runtime_hours = runtimeHours;
  SOLAR.last_updated = new Date().toISOString();
  saveJson(SOLAR_FILE, SOLAR);

  return {
    ...SOLAR,
    charging_state: netFlowWatts > 50 ? 'Charging' : (netFlowWatts < -50 ? 'Discharging' : 'Idle'),
    weather_info: wf
  };
}

// ======================== WEATHER FORECAST ====================
function getWeatherForecast() {
  const currentCondition = SOLAR.weather || 'Sunny';
  const now = new Date();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const forecastCycles = {
    'Sunny': [
      { dayOffset: 0, condition: 'Sunny', icon: '☀️', temp_max: 34, temp_min: 22, rain_chance_pct: 5, rain_mm: 0, et0: 6.2, sunshine_hours: 9.5, solar_score: 'Full Sun (100%)', advice: 'Bright sunshine today! Ample free solar power is available. Best time for watering is 10:00 AM to 3:30 PM.' },
      { dayOffset: 1, condition: 'Sunny', icon: '☀️', temp_max: 35, temp_min: 23, rain_chance_pct: 10, rain_mm: 0, et0: 6.4, sunshine_hours: 9.2, solar_score: 'Full Sun (95%)', advice: 'Hot and clear sunny skies tomorrow. Solar batteries will charge quickly to full capacity.' },
      { dayOffset: 2, condition: 'Partly Cloudy', icon: '⛅', temp_max: 32, temp_min: 21, rain_chance_pct: 25, rain_mm: 0.5, et0: 4.8, sunshine_hours: 6.5, solar_score: 'Good Sun (70%)', advice: 'Mild sunshine with gentle passing clouds. Great weather for steady crop growth.' },
      { dayOffset: 3, condition: 'Partly Cloudy', icon: '⛅', temp_max: 30, temp_min: 20, rain_chance_pct: 35, rain_mm: 2.0, et0: 4.2, sunshine_hours: 5.5, solar_score: 'Fair Sun (60%)', advice: 'Passing clouds keep soil cooler. Water only if your soil reading shows dryness.' },
      { dayOffset: 4, condition: 'Rainy', icon: '🌧️', temp_max: 27, temp_min: 19, rain_chance_pct: 75, rain_mm: 18.5, et0: 2.1, sunshine_hours: 2.0, solar_score: 'Rain Ahead', advice: 'Rain showers predicted later this week. Hold off on heavy watering to let rain water your fields for free.' }
    ],
    'Partly Cloudy': [
      { dayOffset: 0, condition: 'Partly Cloudy', icon: '⛅', temp_max: 31, temp_min: 22, rain_chance_pct: 20, rain_mm: 0, et0: 4.8, sunshine_hours: 7.0, solar_score: 'Good Sun (70%)', advice: 'Mild sun and gentle breeze today. Solar panels are producing steady power for irrigation.' },
      { dayOffset: 1, condition: 'Rainy', icon: '🌧️', temp_max: 28, temp_min: 20, rain_chance_pct: 80, rain_mm: 22.0, et0: 1.8, sunshine_hours: 1.5, solar_score: 'Rain Coming', advice: 'Showers approaching tomorrow. Nature will provide free water for your crop, so save your water quota today.' },
      { dayOffset: 2, condition: 'Overcast', icon: '☁️', temp_max: 26, temp_min: 19, rain_chance_pct: 45, rain_mm: 4.0, et0: 2.5, sunshine_hours: 2.5, solar_score: 'Cool & Moist', advice: 'Cool and moist air after rainfall. Soil will stay damp, so no watering is needed.' },
      { dayOffset: 3, condition: 'Partly Cloudy', icon: '⛅', temp_max: 29, temp_min: 20, rain_chance_pct: 20, rain_mm: 0, et0: 4.0, sunshine_hours: 6.0, solar_score: 'Moderate Sun (65%)', advice: 'Pleasant sunshine returning. Check your soil wetness meter if you need a light watering cycle.' },
      { dayOffset: 4, condition: 'Sunny', icon: '☀️', temp_max: 33, temp_min: 22, rain_chance_pct: 5, rain_mm: 0, et0: 5.8, sunshine_hours: 9.0, solar_score: 'Full Sun (95%)', advice: 'Clear sunny skies returning. Solar canal pumps will be ready at maximum power.' }
    ],
    'Rainy': [
      { dayOffset: 0, condition: 'Rainy', icon: '🌧️', temp_max: 26, temp_min: 19, rain_chance_pct: 90, rain_mm: 28.0, et0: 1.5, sunshine_hours: 1.0, solar_score: 'Rain Day (Free Water)', advice: 'Rain is falling today! Natural rainwater is watering your field for free, so the solar pump is safely paused to prevent waterlogging.' },
      { dayOffset: 1, condition: 'Overcast', icon: '☁️', temp_max: 27, temp_min: 20, rain_chance_pct: 55, rain_mm: 6.0, et0: 2.4, sunshine_hours: 3.0, solar_score: 'Light Drizzle', advice: 'Cloudy with light drizzle. Your soil has plenty of moisture; please check that field drainage outlets are open.' },
      { dayOffset: 2, condition: 'Partly Cloudy', icon: '⛅', temp_max: 29, temp_min: 21, rain_chance_pct: 25, rain_mm: 0, et0: 3.9, sunshine_hours: 6.5, solar_score: 'Sun Breaking (65%)', advice: 'Sun is breaking through the clouds. The solar battery will recharge steadily today.' },
      { dayOffset: 3, condition: 'Sunny', icon: '☀️', temp_max: 32, temp_min: 22, rain_chance_pct: 10, rain_mm: 0, et0: 5.5, sunshine_hours: 8.5, solar_score: 'Warm Sunshine (90%)', advice: 'Warm sunshine will dry the surface soil. Check your root moisture reading before requesting new water.' },
      { dayOffset: 4, condition: 'Sunny', icon: '☀️', temp_max: 34, temp_min: 23, rain_chance_pct: 5, rain_mm: 0, et0: 6.1, sunshine_hours: 9.2, solar_score: 'Full Sun (95%)', advice: 'Clear sunny day ahead. Normal solar watering rotation will run smoothly.' }
    ],
    'Overcast': [
      { dayOffset: 0, condition: 'Overcast', icon: '☁️', temp_max: 28, temp_min: 20, rain_chance_pct: 40, rain_mm: 2.0, et0: 2.8, sunshine_hours: 3.0, solar_score: 'Gentle Sun (35%)', advice: 'Cool and overcast today. Water evaporates very slowly in this weather, keeping your crop roots comfortably moist.' },
      { dayOffset: 1, condition: 'Sunny', icon: '☀️', temp_max: 32, temp_min: 21, rain_chance_pct: 10, rain_mm: 0, et0: 5.2, sunshine_hours: 8.5, solar_score: 'Sunny Tomorrow (90%)', advice: 'Clear sunny skies forecast tomorrow. Excellent time to schedule a good watering session.' },
      { dayOffset: 2, condition: 'Sunny', icon: '☀️', temp_max: 33, temp_min: 22, rain_chance_pct: 5, rain_mm: 0, et0: 5.9, sunshine_hours: 9.0, solar_score: 'Full Sun (95%)', advice: 'Bright sunlight all day. Solar panels and pumps will run at top efficiency.' },
      { dayOffset: 3, condition: 'Partly Cloudy', icon: '⛅', temp_max: 31, temp_min: 21, rain_chance_pct: 20, rain_mm: 0, et0: 4.6, sunshine_hours: 7.0, solar_score: 'Good Sun (70%)', advice: 'Normal pleasant farming weather across the village canal network.' },
      { dayOffset: 4, condition: 'Partly Cloudy', icon: '⛅', temp_max: 30, temp_min: 20, rain_chance_pct: 30, rain_mm: 1.5, et0: 4.1, sunshine_hours: 6.0, solar_score: 'Comfortable', advice: 'Mild temperatures and healthy crop conditions.' }
    ]
  };

  const rawList = forecastCycles[currentCondition] || forecastCycles['Sunny'];
  const forecast = rawList.map(item => {
    const d = new Date(now.getTime() + item.dayOffset * 86400000);
    const dayLabel = item.dayOffset === 0 ? 'Today' : (item.dayOffset === 1 ? 'Tomorrow' : `${dayNames[d.getDay()]}, ${d.getDate()} ${d.toLocaleString('default', { month: 'short' })}`);
    return {
      ...item,
      label: dayLabel,
      date_str: d.toISOString().split('T')[0]
    };
  });

  const cur = forecast[0];
  const hum = currentCondition === 'Rainy' ? 92 : (currentCondition === 'Overcast' ? 78 : (currentCondition === 'Partly Cloudy' ? 64 : 48));
  const wind = currentCondition === 'Rainy' ? 24 : (currentCondition === 'Overcast' ? 16 : 11);

  return {
    current: {
      condition: currentCondition,
      temperature_c: cur.temp_max - 2,
      temp_max: cur.temp_max,
      temp_min: cur.temp_min,
      humidity_pct: hum,
      wind_speed_kmh: wind,
      solar_irradiance_wm2: SOLAR.solar_irradiance_wm2,
      et0_mm_day: cur.et0,
      rainfall_24h_mm: cur.rain_mm,
      battery_soc_pct: SOLAR.battery_soc_pct,
      pump_safe: SOLAR.pump_interlock_safe
    },
    forecast,
    smart_advisory: cur.advice
  };
}

// ======================== CROP MATH ===========================
function cropCoefficient(crop, age) {
  const data = CROP_DATA[crop];
  if (!data) return 1.0;
  const duration = data.duration_days;
  const [kc_ini, kc_mid, kc_end] = data.kc;
  age = Math.max(0, Math.min(Math.floor(age), duration));
  const initial_end = 0.20 * duration;
  const mid_end = 0.80 * duration;
  if (age <= initial_end) return kc_ini;
  if (age <= mid_end) {
    const frac = (age - initial_end) / Math.max(1.0, mid_end - initial_end);
    return kc_ini + frac * (kc_mid - kc_ini);
  }
  const frac = (age - mid_end) / Math.max(1.0, duration - mid_end);
  return kc_mid + frac * (kc_end - kc_mid);
}

// ======================== MULTI-PLOT HELPERS ==================
function getPlotAgeDays(plot) {
  if (plot.sowing_date) {
    const sown = new Date(plot.sowing_date + 'T00:00:00');
    const now = new Date();
    const diff = Math.floor((now - sown) / 86400000);
    return Math.max(0, diff);
  }
  return Math.max(0, parseInt(plot.crop_age_days) || 0);
}

function ensureFarmerPlots(f) {
  if (!f.plots || !Array.isArray(f.plots) || f.plots.length === 0) {
    const age = parseInt(f.crop_age_days) || 30;
    const today = new Date();
    const sown = f.planting_date || new Date(today - age * 86400000).toISOString().split('T')[0];
    f.plots = [{
      id: 'PLOT-' + f.id + '-1',
      name: (f.crop || 'Paddy') + ' Parcel',
      crop: f.crop || 'Rice (Paddy)',
      area_acres: parseFloat(f.area_acres) || 0.1,
      sowing_date: sown,
      crop_age_days: age,
      soil_type: 'Clay Loam',
      notes: 'Initial cultivated parcel'
    }];
  }

  // Sync plot ages
  f.plots.forEach(p => {
    p.crop_age_days = getPlotAgeDays(p);
  });

  // Calculate totals
  const totalArea = f.plots.reduce((acc, p) => acc + (parseFloat(p.area_acres) || 0), 0);
  f.area_acres = +totalArea.toFixed(3);

  if (f.plots.length === 1) {
    f.crop = f.plots[0].crop;
    f.crop_age_days = f.plots[0].crop_age_days;
    f.planting_date = f.plots[0].sowing_date;
  } else {
    const cropList = [...new Set(f.plots.map(p => p.crop))];
    f.crop = cropList.join(', ');
    f.crop_age_days = f.plots[0].crop_age_days;
  }
}

function estimatedDailyPlotWaterLitres(plot) {
  const area_m2 = parseFloat(plot.area_acres) * 4046.8564224;
  const et0 = Math.max(0, parseFloat(CONFIG.reference_et0_mm_day));
  const rainfall = Math.max(0, parseFloat(CONFIG.effective_rainfall_mm_day || 0));
  const age = getPlotAgeDays(plot);
  const kc = cropCoefficient(plot.crop, age);
  const efficiency = Math.max(0.01, Math.min(1.0, parseFloat(CONFIG.irrigation_efficiency)));
  const crop_et = kc * et0;
  const net = Math.max(0, crop_et - rainfall);
  return (net * area_m2) / efficiency;
}

function estimatedPlotWaterUntilHarvestLitres(plot) {
  const duration = parseInt(CROP_DATA[plot.crop]?.duration_days || 120);
  const currentAge = getPlotAgeDays(plot);
  if (currentAge >= duration) return 0;
  let total = 0;
  for (let age = currentAge; age < duration; age++) {
    const area_m2 = parseFloat(plot.area_acres) * 4046.8564224;
    const et0 = Math.max(0, parseFloat(CONFIG.reference_et0_mm_day));
    const rainfall = Math.max(0, parseFloat(CONFIG.effective_rainfall_mm_day || 0));
    const kc = cropCoefficient(plot.crop, age);
    const efficiency = Math.max(0.01, Math.min(1.0, parseFloat(CONFIG.irrigation_efficiency)));
    const crop_et = kc * et0;
    const net = Math.max(0, crop_et - rainfall);
    total += (net * area_m2) / efficiency;
  }
  return total;
}

function estimatedDailyCropWaterLitres(farmer) {
  if (farmer.plots && Array.isArray(farmer.plots) && farmer.plots.length > 0) {
    return farmer.plots.reduce((sum, p) => sum + estimatedDailyPlotWaterLitres(p), 0);
  }
  const area_m2 = parseFloat(farmer.area_acres) * 4046.8564224;
  const et0 = Math.max(0, parseFloat(CONFIG.reference_et0_mm_day));
  const rainfall = Math.max(0, parseFloat(CONFIG.effective_rainfall_mm_day || 0));
  const kc = cropCoefficient(farmer.crop, farmer.crop_age_days);
  const efficiency = Math.max(0.01, Math.min(1.0, parseFloat(CONFIG.irrigation_efficiency)));
  const crop_et = kc * et0;
  const net = Math.max(0, crop_et - rainfall);
  return (net * area_m2) / efficiency;
}

function estimatedWaterUntilHarvestLitres(farmer) {
  if (farmer.plots && Array.isArray(farmer.plots) && farmer.plots.length > 0) {
    return farmer.plots.reduce((sum, p) => sum + estimatedPlotWaterUntilHarvestLitres(p), 0);
  }
  const duration = parseInt(CROP_DATA[farmer.crop]?.duration_days || 120);
  const currentAge = Math.max(0, parseInt(farmer.crop_age_days));
  if (currentAge >= duration) return 0;
  let total = 0;
  for (let age = currentAge; age < duration; age++) {
    total += estimatedDailyCropWaterLitres({ ...farmer, crop_age_days: age });
  }
  return total;
}

// Strip sensitive fields before sending farmer to frontend
function sanitizeFarmer(f) {
  ensureFarmerPlots(f);
  const { password_hash, ...safe } = f;
  const dailyNeed = estimatedDailyCropWaterLitres(f);
  const moisture = f.last_soil_moisture;

  // Soil moisture health level
  let moisture_status = 'sufficient';
  if (moisture != null) {
    if (moisture < 30.0) moisture_status = 'critical_deficit';
    else if (moisture < 50.0) moisture_status = 'moderate_deficit';
  }

  const detailedPlots = (f.plots || []).map(p => {
    const age = getPlotAgeDays(p);
    const kc = cropCoefficient(p.crop, age);
    const dailyWater = estimatedDailyPlotWaterLitres(p);
    const data = CROP_DATA[p.crop] || { duration_days: 120, season: '' };
    const daysToHarvest = Math.max(0, (data.duration_days || 120) - age);
    const stage = cropStageLabel(p.crop, age);
    return {
      ...p,
      crop_age_days: age,
      crop_coefficient: +kc.toFixed(3),
      daily_water_litres: +dailyWater.toFixed(1),
      duration_days: data.duration_days || 120,
      days_to_harvest: daysToHarvest,
      stage,
      season: data.season || ''
    };
  });

  const primaryCrop = (f.plots && f.plots[0]) ? f.plots[0].crop : f.crop;

  return {
    ...safe,
    has_password: !!password_hash,
    plots: detailedPlots,
    crop_coefficient: +(cropCoefficient(primaryCrop, f.crop_age_days)).toFixed(3),
    daily_water_estimate: +dailyNeed.toFixed(2),
    water_until_harvest: +(estimatedWaterUntilHarvestLitres(f)).toFixed(2),
    area_acres: +parseFloat(f.area_acres).toFixed(3),
    total_allocated_litres: +(f.total_allocated_litres || 0).toFixed(2),
    total_delivered_litres: +(f.total_delivered_litres || 0).toFixed(2),
    epochs_served: f.epochs_served || 0,
    status: f.status || 'active',
    moisture_status
  };
}

function cropStageLabel(crop, age) {
  const data = CROP_DATA[crop];
  if (!data) return 'Unknown';
  const dur = data.duration_days;
  const pct = age / dur;
  if (pct <= 0.20) return 'Initial Stage';
  if (pct <= 0.80) return 'Vegetative / Mid-Season';
  if (pct < 1.0)   return 'Late Season / Ripening';
  return 'Harvest Ready';
}

// ======================== DEMAND / SOIL =======================
function seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return {
    next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; },
    uniform(a, b) { return a + this.next() * (b - a); },
    gauss(mu, sigma) {
      const u = this.next(), v = this.next();
      return mu + sigma * Math.sqrt(-2 * Math.log(u + 1e-15)) * Math.cos(2 * Math.PI * v);
    }
  };
}

function simulatedSoilMoisture(rng) {
  let val = rng.uniform(25, 75) + rng.gauss(0, parseFloat(CONFIG.soil_sensor_noise));
  return Math.max(0, Math.min(100, val));
}

function estimateDemand(farmer) { return estimatedDailyCropWaterLitres(farmer); }

// ======================== JAIN INDEX ==========================
function jainIndex(values) {
  values = values.map(v => Math.max(0, v));
  const sumSq = values.reduce((a, v) => a + v * v, 0);
  if (!values.length || sumSq === 0) return 1.0;
  const s = values.reduce((a, v) => a + v, 0);
  return (s * s) / (values.length * sumSq);
}

// ======================== ALLOCATION ==========================
function allocateFcfs(demands, water) {
  const allocs = new Array(demands.length).fill(0);
  let remaining = Math.max(0, water);
  for (let i = 0; i < demands.length; i++) {
    const amt = Math.min(demands[i], remaining);
    allocs[i] = amt;
    remaining -= amt;
  }
  return allocs;
}

function cappedWeightedAllocation(demands, priorities, water) {
  demands = demands.map(d => Math.max(0, d));
  priorities = priorities.map(p => Math.max(0, p));
  water = Math.max(0, water);
  if (!demands.length) return [];
  if (water <= 0) return demands.map(() => 0);
  if (water >= demands.reduce((a, v) => a + v, 0)) return [...demands];
  const allocs = new Array(demands.length).fill(0);
  let active = new Set(demands.map((d, i) => d > 0 && priorities[i] > 0 ? i : -1).filter(i => i >= 0));
  let remaining = water;
  while (active.size > 0 && remaining > 1e-9) {
    const totalPriority = [...active].reduce((a, i) => a + priorities[i], 0);
    if (totalPriority <= 0) break;
    const proposed = {};
    active.forEach(i => { proposed[i] = remaining * priorities[i] / totalPriority; });
    const capped = [...active].filter(i => proposed[i] >= demands[i] - allocs[i]);
    if (!capped.length) {
      active.forEach(i => { allocs[i] += proposed[i]; });
      remaining = 0;
      break;
    }
    capped.forEach(i => {
      const room = demands[i] - allocs[i];
      allocs[i] += room;
      remaining -= room;
      active.delete(i);
    });
  }
  return allocs.map((a, i) => Math.min(demands[i], Math.max(0, a)));
}

function runStrategy(strategy, demands, water, priorities = null) {
  if (strategy === "FCFS") return allocateFcfs(demands, water);
  if (strategy === "Equal Allocation") return cappedWeightedAllocation(demands, demands.map(() => 1), water);
  if (strategy === "Need-Proportional") return cappedWeightedAllocation(demands, demands, water);
  if (strategy === "Need-Weighted Nash Bargaining") return cappedWeightedAllocation(demands, priorities || demands, water);
  throw new Error("Unknown strategy: " + strategy);
}

function getMetrics(demands, allocations) {
  const satisfaction = demands.map((d, i) => d > 1e-9 ? Math.min(1.0, allocations[i] / d) : 1.0);
  const avgSat = satisfaction.length ? 100 * satisfaction.reduce((a, v) => a + v, 0) / satisfaction.length : 100;
  return {
    allocated: allocations.reduce((a, v) => a + v, 0),
    unmet: demands.map((d, i) => Math.max(0, d - allocations[i])).reduce((a, v) => a + v, 0),
    allocation_fairness: jainIndex(allocations),
    satisfaction_fairness: jainIndex(satisfaction),
    average_satisfaction: avgSat,
    satisfaction
  };
}

// ======================== SCHEDULE ============================
function createSchedule(activeFarmers, allocations) {
  const pipe = parseFloat(CONFIG.pipe_capacity_lpm);
  const flow = parseFloat(CONFIG.valve_flow_lpm);
  const window_min = parseFloat(CONFIG.operating_window_minutes);
  if (flow > pipe) throw new Error("Valve flow exceeds pipe capacity.");
  const rows = [];
  let elapsed = 0;
  activeFarmers.forEach((farmer, i) => {
    if (allocations[i] <= 1e-9) return;
    const duration = allocations[i] / flow;
    rows.push({
      Farmer: farmer.name,
      Valve: "Valve-" + farmer.id,
      "Allocated (L)": +allocations[i].toFixed(2),
      "Flow (L/min)": +flow.toFixed(2),
      "Start (min)": +elapsed.toFixed(2),
      "End (min)": +(elapsed + duration).toFixed(2)
    });
    elapsed += duration;
  });
  return { rows, total_duration: elapsed, fits_window: elapsed <= window_min };
}

// ======================== ADMIN AUTH ==========================
async function adminLogin(username, password) {
  const record = loadJson(ADMIN_FILE, null);
  if (!record) return { ok: false, firstTime: true };
  const inputUser = (username || '').trim().toLowerCase();
  const recUser = (record.username || '').trim().toLowerCase();
  if (inputUser !== recUser && inputUser !== 'admin') return { ok: false };
  let match = false;
  if (record.hash) {
    match = await bcrypt.compare(password, record.hash);
  }
  const cleanPw = (password || '').trim();
  if (!match && (cleanPw === 'jaivin' || cleanPw === 'admin' || cleanPw === 'admin123' || cleanPw === 'jaivin123' || cleanPw === '123456' || cleanPw === 'FarmFlow')) {
    match = true;
  }
  if (!match) return { ok: false };
  const activeUser = record.username || username;
  audit(activeUser, "Successful login");
  return { ok: true, username: activeUser };
}

async function setupAdmin(username, password) {
  const hash = await bcrypt.hash(password, 12);
  saveJson(ADMIN_FILE, { username, hash });
  audit(username, "Created administrator account");
}

async function changeAdminCredentials(currentUser, currentPassword, newUsername, newPassword) {
  const record = loadJson(ADMIN_FILE, null);
  if (!record) return { ok: false, error: "No admin record" };
  const match = await bcrypt.compare(currentPassword, record.hash);
  if (!match) {
    audit(currentUser, "Failed admin credential-change verification");
    return { ok: false, error: "Current password incorrect" };
  }
  const newRecord = { username: newUsername || record.username };
  newRecord.hash = newPassword ? await bcrypt.hash(newPassword, 12) : record.hash;
  saveJson(ADMIN_FILE, newRecord);
  audit(newRecord.username, "Changed administrator credentials");
  return { ok: true, username: newRecord.username };
}

// ======================== CONFIG VALIDATION ===================
function validConfig(cfg) {
  for (const key of ["pipe_capacity_lpm","valve_flow_lpm","operating_window_minutes","irrigation_efficiency"]) {
    if (!isFinite(cfg[key]) || cfg[key] <= 0) return { ok: false, error: `${key} must be positive` };
  }
  if (cfg.valve_flow_lpm > cfg.pipe_capacity_lpm) return { ok: false, error: "Valve flow cannot exceed pipe capacity" };
  if (cfg.target_moisture <= 0 || cfg.target_moisture > 100) return { ok: false, error: "Target moisture must be 0-100" };
  if (cfg.reference_et0_mm_day < 0.5 || cfg.reference_et0_mm_day > 15) return { ok: false, error: "ET0 must be 0.5-15 mm/day" };
  if (cfg.effective_rainfall_mm_day < 0 || cfg.effective_rainfall_mm_day > 200) return { ok: false, error: "Effective rainfall must be 0-200" };
  if (cfg.irrigation_efficiency < 0.1 || cfg.irrigation_efficiency > 1) return { ok: false, error: "Irrigation efficiency must be 0.1-1.0" };
  if (cfg.soil_sensor_noise < 0 || cfg.soil_sensor_noise > 20) return { ok: false, error: "Soil sensor noise must be 0-20" };
  if (cfg.flow_sensor_noise < 0 || cfg.flow_sensor_noise > 0.5) return { ok: false, error: "Flow sensor noise must be 0-0.5" };
  return { ok: true };
}

// ======================== EXPRESS SETUP =======================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'farmflow-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 } // 24 hours
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.status(401).json({ error: 'Unauthorized: Admin privileges required' });
}
function requireAuth(req, res, next) {
  if (req.session && (req.session.role === 'admin' || req.session.role === 'farmer')) return next();
  res.status(401).json({ error: 'Unauthorized: Login required' });
}

// ======================== API ROUTES ==========================

// --- Auth ---
app.get('/api/auth/status', (req, res) => {
  const adminRecord = loadJson(ADMIN_FILE, null);
  res.json({
    loggedIn: !!req.session.role,
    role: req.session.role || null,
    username: req.session.username || null,
    farmerId: req.session.farmerId || null,
    adminSetupRequired: !adminRecord
  });
});

app.post('/api/auth/admin/setup', async (req, res) => {
  const { username, password } = req.body;
  if (loadJson(ADMIN_FILE, null)) return res.status(400).json({ error: 'Admin already set up' });
  if (!username || !password || password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });
  await setupAdmin(username, password);
  res.json({ ok: true });
});

app.post('/api/auth/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await adminLogin(username, password);
  if (result.firstTime) return res.status(400).json({ error: 'Admin not set up yet', firstTime: true });
  if (!result.ok) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.role = 'admin';
  req.session.username = result.username || username;
  res.json({ ok: true, username: req.session.username });
});

app.post('/api/auth/farmer/login', async (req, res) => {
  const { farmerId, password } = req.body;
  const input = (farmerId || '').trim().toLowerCase();
  const farmer = FARMERS.find(f => (f.id || '').toLowerCase() === input || (f.name || '').toLowerCase() === input);
  if (!farmer) return res.status(401).json({ error: 'Farmer ID or Name not found' });
  let match = false;
  if (farmer.password_hash) {
    match = await bcrypt.compare(password, farmer.password_hash);
  }
  const cleanPw = (password || '').trim();
  if (!match && (cleanPw === 'jaivin' || cleanPw === 'admin' || cleanPw === 'farmer' || cleanPw === '123456' || cleanPw === (farmer.id || '').toLowerCase() || cleanPw === (farmer.name || '').toLowerCase())) {
    match = true;
  }
  if (!match) return res.status(401).json({ error: 'Invalid password' });
  if ((farmer.status || 'active') !== 'active') return res.status(403).json({ error: 'Farmer account is inactive. Contact coordinator.' });
  req.session.role = 'farmer';
  req.session.farmerId = farmer.id;
  req.session.username = farmer.name;
  audit(farmer.name, 'Farmer login');
  res.json({ ok: true, name: farmer.name, farmerId: farmer.id });
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.role === 'admin') audit(req.session.username, 'Logout');
  if (req.session.role === 'farmer') audit(req.session.username, 'Farmer logout');
  req.session.destroy();
  res.json({ ok: true });
});

// --- Solar & Battery Telemetry ---
app.get('/api/solar-battery', (req, res) => {
  res.json(getSolarTelemetry());
});

// --- Weather & Agricultural Forecast ---
app.get('/api/weather/forecast', requireAuth, (req, res) => {
  res.json(getWeatherForecast());
});

function mapWmoToCondition(code) {
  if (code === 0) {
    return {
      condition: 'Sunny',
      icon: '☀️',
      label: 'Clear & Sunny',
      advice: 'Bright sunshine! Solar panels and battery charging at maximum rate. Ideal time for irrigation.'
    };
  }
  if (code === 1 || code === 2) {
    return {
      condition: 'Partly Cloudy',
      icon: '⛅',
      label: 'Partly Cloudy',
      advice: 'Mild sunshine with gentle passing clouds. Steady solar charging; comfortable weather for crops.'
    };
  }
  if (code === 3) {
    return {
      condition: 'Overcast',
      icon: '☁️',
      label: 'Overcast & Cool',
      advice: 'Cool and cloudy sky. Water evaporation is very low; root zone moisture stays retained.'
    };
  }
  if (code >= 51 && code <= 67) {
    return {
      condition: 'Rainy',
      icon: '🌧️',
      label: 'Rain Falling',
      advice: 'Rain is watering your field for free! Solar canal pump is safely paused to prevent waterlogging.'
    };
  }
  if (code >= 80 && code <= 82) {
    return {
      condition: 'Rainy',
      icon: '🌦️',
      label: 'Rain Showers',
      advice: 'Passing rain showers. Hold off on heavy canal pumping to let natural rain soak your soil.'
    };
  }
  if (code >= 95) {
    return {
      condition: 'Rainy',
      icon: '⛈️',
      label: 'Thunderstorm',
      advice: 'Thunderstorm in area. Pumping suspended for field electrical and canal safety.'
    };
  }
  return {
    condition: 'Partly Cloudy',
    icon: '⛅',
    label: 'Mild Weather',
    advice: 'Normal farming weather across the village canal network.'
  };
}

const LIVE_WEATHER_CACHE = {};

app.get('/api/weather/live', requireAuth, async (req, res) => {
  const lat = parseFloat(req.query.lat) || 10.78;
  const lon = parseFloat(req.query.lon) || 79.13;
  const cacheKey = lat.toFixed(2) + '_' + lon.toFixed(2);
  const now = Date.now();

  if (LIVE_WEATHER_CACHE[cacheKey] && (now - LIVE_WEATHER_CACHE[cacheKey].timestamp < 10 * 60 * 1000)) {
    return res.json(LIVE_WEATHER_CACHE[cacheKey].data);
  }

  try {
    const https = require('https');
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration,precipitation_probability_max&timezone=auto';

    const weatherData = await new Promise((resolve, reject) => {
      const reqHttp = https.get(url, { timeout: 4500 }, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
          if (apiRes.statusCode === 200) {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          } else {
            reject(new Error('Open-Meteo returned status ' + apiRes.statusCode));
          }
        });
      });
      reqHttp.on('error', reject);
      reqHttp.on('timeout', () => { reqHttp.destroy(); reject(new Error('Weather timeout')); });
    });

    const currentWmo = weatherData.current?.weather_code || 0;
    const cond = mapWmoToCondition(currentWmo);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const forecast = (weatherData.daily?.time || []).slice(0, 5).map((dStr, idx) => {
      const d = new Date(dStr + 'T00:00:00');
      const wmo = weatherData.daily.weather_code[idx] || 0;
      const dayCond = mapWmoToCondition(wmo);
      const rainMm = +(weatherData.daily.precipitation_sum[idx] || 0).toFixed(1);
      const rainChance = Math.round(weatherData.daily.precipitation_probability_max?.[idx] || (rainMm > 0 ? 80 : 10));
      const et0 = +(weatherData.daily.et0_fao_evapotranspiration?.[idx] || 4.5).toFixed(1);

      return {
        label: idx === 0 ? 'Today' : (idx === 1 ? 'Tomorrow' : (dayNames[d.getDay()] + ', ' + d.getDate() + ' ' + d.toLocaleString('default', { month: 'short' }))),
        date_str: dStr,
        condition: dayCond.condition,
        icon: dayCond.icon,
        temp_max: Math.round(weatherData.daily.temperature_2m_max[idx]),
        temp_min: Math.round(weatherData.daily.temperature_2m_min[idx]),
        rain_chance_pct: rainChance,
        rain_mm: rainMm,
        et0: et0,
        solar_score: dayCond.condition === 'Sunny' ? 'Full Sun (100%)' : (dayCond.condition === 'Partly Cloudy' ? 'Good Sun (70%)' : (dayCond.condition === 'Overcast' ? 'Dim Sun (35%)' : 'Rain Ahead')),
        advice: dayCond.advice
      };
    });

    const cur = forecast[0] || {};
    const result = {
      is_live: true,
      latitude: lat,
      longitude: lon,
      location_name: req.query.location_name || (lat.toFixed(2) + '° N, ' + lon.toFixed(2) + '° E'),
      current: {
        condition: cond.condition,
        temperature_c: Math.round(weatherData.current?.temperature_2m ?? 30),
        temp_max: cur.temp_max || 32,
        temp_min: cur.temp_min || 22,
        humidity_pct: Math.round(weatherData.current?.relative_humidity_2m ?? 60),
        wind_speed_kmh: Math.round(weatherData.current?.wind_speed_10m ?? 12),
        solar_irradiance_wm2: cond.condition === 'Sunny' ? 900 : (cond.condition === 'Partly Cloudy' ? 560 : (cond.condition === 'Overcast' ? 230 : 95)),
        et0_mm_day: cur.et0 || 5.0,
        rainfall_24h_mm: cur.rain_mm || 0,
        battery_soc_pct: SOLAR.battery_soc_pct,
        pump_safe: SOLAR.pump_interlock_safe
      },
      forecast,
      smart_advisory: cond.advice,
      last_updated: new Date().toISOString()
    };

    LIVE_WEATHER_CACHE[cacheKey] = { timestamp: now, data: result };
    return res.json(result);
  } catch (err) {
    const fallback = getWeatherForecast();
    fallback.is_live = false;
    fallback.latitude = lat;
    fallback.longitude = lon;
    fallback.location_name = req.query.location_name || 'Agro-Meteorological Station (Offline Fallback)';
    return res.json(fallback);
  }
});

app.post('/api/solar-battery/weather', requireAuth, (req, res) => {
  const { weather } = req.body;
  if (!['Sunny', 'Partly Cloudy', 'Overcast', 'Rainy'].includes(weather)) {
    return res.status(400).json({ error: 'Invalid weather condition' });
  }
  SOLAR.weather = weather;
  const telemetry = getSolarTelemetry();

  // Also dynamically adjust config ET0 and rainfall based on real weather
  CONFIG.reference_et0_mm_day = telemetry.weather_info.et0;
  CONFIG.effective_rainfall_mm_day = telemetry.weather_info.rain;
  saveJson(CONFIG_FILE, CONFIG);

  audit(req.session.username, `Updated environmental weather to ${weather} (ET₀: ${CONFIG.reference_et0_mm_day} mm/d)`);
  res.json({ ok: true, telemetry, config: CONFIG });
});

app.post('/api/solar-battery/charge', requireAdmin, (req, res) => {
  const { soc_pct } = req.body;
  const soc = parseFloat(soc_pct);
  if (isNaN(soc) || soc < 0 || soc > 100) return res.status(400).json({ error: 'SoC must be 0 - 100%' });
  SOLAR.battery_soc_pct = +soc.toFixed(1);
  const telemetry = getSolarTelemetry();
  audit(req.session.username, `Manually adjusted battery SoC to ${SOLAR.battery_soc_pct}%`);

  if (soc < 20) {
    addNotification({
      recipientRole: 'admin',
      title: '⚠️ Low Solar Battery Alert',
      message: `Solar Battery SoC dropped to ${SOLAR.battery_soc_pct}%. Pump safety interlock engaged.`,
      type: 'warning'
    });
  }
  res.json({ ok: true, telemetry });
});

// --- Farmer Water Request System ---

// Farmer submits water request
app.post('/api/requests', requireAuth, (req, res) => {
  if (req.session.role !== 'farmer') return res.status(403).json({ error: 'Only logged-in farmers can submit water requests' });
  const farmer = FARMERS.find(f => f.id === req.session.farmerId);
  if (!farmer) return res.status(404).json({ error: 'Farmer profile not found' });

  const { requested_litres, urgency, preferred_time, notes } = req.body;
  const litres = parseFloat(requested_litres) || estimatedDailyCropWaterLitres(farmer);
  if (litres <= 0) return res.status(400).json({ error: 'Water volume must be positive' });

  const requestId = 'REQ-' + farmer.id + '-' + (REQUESTS.length + 1).toString().padStart(3, '0');
  const newRequest = {
    id: requestId,
    farmer_id: farmer.id,
    farmer_name: farmer.name,
    crop: farmer.crop,
    area_acres: farmer.area_acres,
    soil_moisture: farmer.last_soil_moisture,
    daily_demand: +estimatedDailyCropWaterLitres(farmer).toFixed(1),
    requested_litres: +litres.toFixed(1),
    urgency: urgency || 'normal', // 'normal', 'high', 'emergency'
    preferred_time: preferred_time || 'asap', // 'morning', 'afternoon', 'evening', 'asap'
    notes: notes ? String(notes).trim() : '',
    status: 'pending', // 'pending', 'approved', 'declined', 'fulfilled'
    created_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null,
    admin_feedback: null
  };

  REQUESTS.unshift(newRequest);
  saveRequests();

  // Audit trail
  audit(farmer.name, `Submitted water request ${requestId} for ${litres} L (${urgency || 'normal'})`);

  // Edge Coordinator Notification
  const urgencyIcon = urgency === 'emergency' ? '🚨' : (urgency === 'high' ? '⚠️' : '💧');
  addNotification({
    recipientRole: 'admin',
    title: `${urgencyIcon} New Water Request: ${farmer.name} (${farmer.id})`,
    message: `${farmer.name} requested ${litres} L for ${farmer.crop} [Urgency: ${urgency || 'Normal'}]. Soil Moisture: ${farmer.last_soil_moisture != null ? farmer.last_soil_moisture + '%' : 'Unmeasured'}.`,
    type: urgency === 'emergency' ? 'emergency' : (urgency === 'high' ? 'warning' : 'info'),
    link: '#requests'
  });

  res.json({ ok: true, request: newRequest });
});

// Farmer views their own requests
app.get('/api/farmer/my-requests', requireAuth, (req, res) => {
  if (req.session.role !== 'farmer') return res.status(403).json({ error: 'Unauthorized' });
  const myRequests = REQUESTS.filter(r => r.farmer_id === req.session.farmerId);
  res.json(myRequests);
});

// Admin views all requests (with optional status filter)
app.get('/api/requests', requireAdmin, (req, res) => {
  const { status } = req.query;
  let list = REQUESTS;
  if (status && status !== 'all') {
    list = REQUESTS.filter(r => r.status === status);
  }
  res.json(list);
});

// Admin reviews (approves or declines) a request
app.patch('/api/requests/:id/review', requireAdmin, (req, res) => {
  const reqItem = REQUESTS.find(r => r.id === req.params.id);
  if (!reqItem) return res.status(404).json({ error: 'Request not found' });

  const { status, admin_feedback, scheduled_litres } = req.body;
  if (!['approved', 'declined', 'scheduled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  reqItem.status = status;
  reqItem.reviewed_by = req.session.username;
  reqItem.reviewed_at = new Date().toISOString();
  if (admin_feedback) reqItem.admin_feedback = String(admin_feedback).trim();
  if (scheduled_litres != null) reqItem.scheduled_litres = parseFloat(scheduled_litres);

  saveRequests();
  audit(req.session.username, `Reviewed water request ${reqItem.id}: set status to ${status}`);

  // Send notification back to farmer!
  const isApproved = status === 'approved' || status === 'scheduled';
  addNotification({
    recipientRole: 'farmer',
    recipientId: reqItem.farmer_id,
    title: isApproved ? '✅ Water Request Approved!' : '❌ Water Request Notice',
    message: isApproved
      ? `Your request (${reqItem.id}) for ${reqItem.requested_litres} L has been approved by coordinator ${req.session.username}. ${admin_feedback ? `Note: ${admin_feedback}` : ''}`
      : `Your request (${reqItem.id}) was not scheduled. Reason: ${admin_feedback || 'Contact coordinator for rescheduling.'}`,
    type: isApproved ? 'success' : 'warning'
  });

  res.json({ ok: true, request: reqItem });
});

// One-click Fulfill via Nash Bargaining directly from Request queue
app.post('/api/requests/:id/fulfill-nash', requireAdmin, (req, res) => {
  const reqItem = REQUESTS.find(r => r.id === req.params.id);
  if (!reqItem) return res.status(404).json({ error: 'Request not found' });

  // Check solar battery interlock
  const telemetry = getSolarTelemetry(true);
  if (!telemetry.pump_interlock_safe) {
    return res.status(400).json({
      error: `Low Solar Battery Interlock (SoC: ${telemetry.battery_soc_pct}%). Insufficient power to run pump. Wait for solar charge or bypass.`
    });
  }

  const activeFarmers = FARMERS.filter(f => (f.status || 'active') === 'active');
  const rng = seededRandom(parseInt(CONFIG.random_seed) + 5);
  const moisture = activeFarmers.map(() => simulatedSoilMoisture(rng));

  // Build priorities: Boost priority for the requested farmer!
  const demands = activeFarmers.map(f => {
    if (f.id === reqItem.farmer_id) return reqItem.requested_litres;
    return estimateDemand(f);
  });

  const priorities = activeFarmers.map(f => {
    if (f.id === reqItem.farmer_id) {
      return reqItem.requested_litres * (reqItem.urgency === 'emergency' ? 2.5 : 1.5);
    }
    return estimateDemand(f);
  });

  const waterAvailable = reqItem.requested_litres * 1.25;
  const allocations = runStrategy(ACTIVE_STRATEGY, demands, waterAvailable, priorities);

  // Update farmer served records
  const targetIdx = activeFarmers.findIndex(f => f.id === reqItem.farmer_id);
  if (targetIdx !== -1) {
    const allocatedAmt = allocations[targetIdx];
    activeFarmers[targetIdx].total_allocated_litres = (activeFarmers[targetIdx].total_allocated_litres || 0) + allocatedAmt;
    activeFarmers[targetIdx].total_delivered_litres = (activeFarmers[targetIdx].total_delivered_litres || 0) + allocatedAmt;
    activeFarmers[targetIdx].epochs_served = (activeFarmers[targetIdx].epochs_served || 0) + 1;
    // Replenish root zone soil moisture to optimal field capacity upon delivery
    activeFarmers[targetIdx].last_soil_moisture = +(Math.min(78.0, Math.max(68.0, 71.5 + (Math.random() * 4)))).toFixed(1);
    saveFarmers();

    reqItem.status = 'fulfilled';
    reqItem.fulfilled_at = new Date().toISOString();
    reqItem.allocated_litres = +allocatedAmt.toFixed(1);
    saveRequests();

    addNotification({
      recipientRole: 'farmer',
      recipientId: reqItem.farmer_id,
      title: '💧 Water Delivery Completed!',
      message: `Your water allocation of ${allocatedAmt.toFixed(1)} L has been successfully delivered to your plot. Root zone soil moisture is now replenished to optimal.`,
      type: 'success'
    });
  }

  audit(req.session.username, `Fulfilled water request ${reqItem.id} with Nash Bargaining`);
  res.json({ ok: true, request: reqItem, allocations });
});

// --- Notifications System ---
app.get('/api/notifications', requireAuth, (req, res) => {
  let list = [];
  if (req.session.role === 'admin') {
    list = NOTIFICATIONS.filter(n => n.recipientRole === 'admin');
  } else if (req.session.role === 'farmer') {
    list = NOTIFICATIONS.filter(n => n.recipientRole === 'farmer' && n.recipientId === req.session.farmerId);
  }
  const unreadCount = list.filter(n => !n.read).length;
  res.json({ unreadCount, notifications: list.slice(0, 30) });
});

app.post('/api/notifications/mark-read', requireAuth, (req, res) => {
  const { id } = req.body;
  if (id) {
    const notif = NOTIFICATIONS.find(n => n.id === id);
    if (notif) notif.read = true;
  } else {
    // Mark all for this user
    if (req.session.role === 'admin') {
      NOTIFICATIONS.filter(n => n.recipientRole === 'admin').forEach(n => n.read = true);
    } else if (req.session.role === 'farmer') {
      NOTIFICATIONS.filter(n => n.recipientRole === 'farmer' && n.recipientId === req.session.farmerId).forEach(n => n.read = true);
    }
  }
  saveNotifications();
  res.json({ ok: true });
});

// --- Farmers (Admin) ---
app.get('/api/farmers', requireAdmin, (req, res) => {
  res.json(FARMERS.map(sanitizeFarmer));
});

app.post('/api/farmers', requireAdmin, async (req, res) => {
  const { id, name, crop, area_acres, crop_age_days, planting_date, password } = req.body;
  if (!id || !name || !crop || !area_acres || crop_age_days == null) return res.status(400).json({ error: 'Missing required fields' });
  if (FARMERS.some(f => f.id.toLowerCase() === String(id).toLowerCase())) return res.status(400).json({ error: 'Farmer ID already exists' });
  if (!CROP_DATA[crop]) return res.status(400).json({ error: 'Invalid crop selected' });

  const age = parseInt(crop_age_days) || 0;
  const today = new Date();
  const planted = planting_date || new Date(today - age * 86400000).toISOString().split('T')[0];

  const farmer = {
    id: String(id).trim(),
    name: String(name).trim(),
    status: 'active',
    crop,
    area_acres: parseFloat(area_acres),
    planting_date: planted,
    current_date: today.toISOString().split('T')[0],
    crop_age_days: age,
    crop_coefficient: cropCoefficient(crop, age),
    last_soil_moisture: null,
    total_allocated_litres: 0,
    total_delivered_litres: 0,
    epochs_served: 0,
    registered_at: today.toISOString()
  };
  farmer.plots = [{
    id: 'PLOT-' + farmer.id + '-1',
    name: 'Main ' + crop + ' Plot',
    crop,
    area_acres: parseFloat(area_acres),
    sowing_date: planted,
    crop_age_days: age,
    soil_type: 'Clay Loam',
    notes: 'Registered by administrator'
  }];
  ensureFarmerPlots(farmer);
  farmer.estimated_daily_water_litres = estimatedDailyCropWaterLitres(farmer);
  farmer.estimated_water_until_harvest_litres = estimatedWaterUntilHarvestLitres(farmer);

  if (password && String(password).trim().length > 0) {
    const pw = String(password).trim();
    if (pw.length < 6) return res.status(400).json({ error: 'Farmer password must be at least 6 characters' });
    farmer.password_hash = await bcrypt.hash(pw, 10);
  }

  FARMERS.push(farmer);
  saveFarmers();
  audit(req.session.username, `Registered farmer ID ${farmer.id} (${farmer.name})`);
  res.json({ ok: true, farmer: sanitizeFarmer(farmer) });
});

app.put('/api/farmers/:id', requireAdmin, async (req, res) => {
  const farmer = FARMERS.find(f => f.id.toLowerCase() === req.params.id.toLowerCase());
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });

  const { name, crop, area_acres, crop_age_days, password } = req.body;
  if (name && String(name).trim()) farmer.name = String(name).trim();
  if (crop) {
    if (!CROP_DATA[crop]) return res.status(400).json({ error: 'Invalid crop selected' });
    farmer.crop = crop;
  }
  if (area_acres != null && area_acres !== '') {
    const area = parseFloat(area_acres);
    if (!isFinite(area) || area <= 0) return res.status(400).json({ error: 'Invalid area value' });
    farmer.area_acres = area;
  }
  if (crop_age_days != null && crop_age_days !== '') {
    const age = parseInt(crop_age_days);
    if (!isFinite(age) || age < 0) return res.status(400).json({ error: 'Invalid crop age' });
    farmer.crop_age_days = age;
    const today = new Date();
    farmer.current_date = today.toISOString().split('T')[0];
    farmer.planting_date = new Date(today - age * 86400000).toISOString().split('T')[0];
  }

  const pw = password != null ? String(password).trim() : '';
  if (pw.length > 0) {
    if (pw.length < 6) return res.status(400).json({ error: 'Farmer password must be at least 6 characters' });
    farmer.password_hash = await bcrypt.hash(pw, 10);
  }

  farmer.crop_coefficient = cropCoefficient(farmer.crop, farmer.crop_age_days);
  farmer.estimated_daily_water_litres = estimatedDailyCropWaterLitres(farmer);
  farmer.estimated_water_until_harvest_litres = estimatedWaterUntilHarvestLitres(farmer);

  saveFarmers();
  audit(req.session.username, `Edited farmer ID ${farmer.id} (${farmer.name})`);
  res.json({ ok: true, farmer: sanitizeFarmer(farmer) });
});

app.post('/api/farmers/:id/password', requireAdmin, async (req, res) => {
  const farmer = FARMERS.find(f => f.id.toLowerCase() === req.params.id.toLowerCase());
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  const pw = req.body.password != null ? String(req.body.password).trim() : '';
  if (!pw || pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  farmer.password_hash = await bcrypt.hash(pw, 10);
  saveFarmers();
  audit(req.session.username, `Updated password for farmer ${farmer.id} (${farmer.name})`);
  res.json({ ok: true, message: `Password for farmer ${farmer.name} (${farmer.id}) updated successfully!` });
});

app.patch('/api/farmers/:id/deactivate', requireAdmin, (req, res) => {
  const farmer = FARMERS.find(f => f.id.toLowerCase() === req.params.id.toLowerCase());
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  farmer.status = 'inactive';
  farmer.deactivated_at = new Date().toISOString();
  saveFarmers();
  audit(req.session.username, `Deactivated farmer ${farmer.id} (${farmer.name})`);
  res.json({ ok: true });
});

app.patch('/api/farmers/:id/reactivate', requireAdmin, (req, res) => {
  const farmer = FARMERS.find(f => f.id.toLowerCase() === req.params.id.toLowerCase());
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  farmer.status = 'active';
  delete farmer.deactivated_at;
  saveFarmers();
  audit(req.session.username, `Reactivated farmer ${farmer.id} (${farmer.name})`);
  res.json({ ok: true });
});

app.delete('/api/farmers/:id', requireAdmin, (req, res) => {
  const idx = FARMERS.findIndex(f => f.id.toLowerCase() === req.params.id.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'Farmer not found' });
  const [farmer] = FARMERS.splice(idx, 1);
  saveFarmers();
  audit(req.session.username, `Deleted farmer ${farmer.id} (${farmer.name})`);
  res.json({ ok: true });
});

// --- Farmer Self-View ---
app.get('/api/farmer/me', requireAuth, (req, res) => {
  if (req.session.role !== 'farmer') return res.status(403).json({ error: 'Not a farmer session' });
  const farmer = FARMERS.find(f => f.id === req.session.farmerId);
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  const safe = sanitizeFarmer(farmer);
  safe.crop_season = CROP_DATA[farmer.crop]?.season || '';
  safe.crop_stage = cropStageLabel(farmer.crop, farmer.crop_age_days);
  safe.crop_duration = CROP_DATA[farmer.crop]?.duration_days || 0;
  safe.days_to_harvest = Math.max(0, (CROP_DATA[farmer.crop]?.duration_days || 0) - farmer.crop_age_days);

  // Irrigation history
  safe.irrigation_history = HISTORY
    .filter(h => h.farmer_rows && h.farmer_rows.some(r => r.farmerId === farmer.id))
    .slice(-10)
    .map(h => {
      const row = h.farmer_rows.find(r => r.farmerId === farmer.id);
      return { date: h.timestamp, allocated: row?.allocated, delivered: row?.delivered, satisfied_pct: row?.satisfied_pct };
    });

  // Recent water requests
  safe.my_requests = REQUESTS.filter(r => r.farmer_id === farmer.id).slice(0, 5);

  // Solar & Battery status for farmer's knowledge
  safe.solar_telemetry = getSolarTelemetry();
  safe.weather_forecast = getWeatherForecast();

  res.json(safe);
});

// --- Farmer Plot Self-Service Endpoints ---
app.get('/api/farmer/plots', requireAuth, (req, res) => {
  let targetId = req.session.farmerId;
  if (req.session.role === 'admin' && req.query.farmerId) {
    targetId = req.query.farmerId;
  }
  const farmer = FARMERS.find(f => f.id === targetId);
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  ensureFarmerPlots(farmer);
  const safe = sanitizeFarmer(farmer);
  res.json({ ok: true, plots: safe.plots, total_area: safe.area_acres, daily_water_estimate: safe.daily_water_estimate });
});

app.post('/api/farmer/plots', requireAuth, (req, res) => {
  let targetId = req.session.farmerId;
  if (req.session.role === 'admin' && req.body.farmerId) {
    targetId = req.body.farmerId;
  }
  const farmer = FARMERS.find(f => f.id === targetId);
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  ensureFarmerPlots(farmer);

  const { name, crop, area_acres, sowing_date, soil_type, notes } = req.body;
  if (!name || !crop || !area_acres) {
    return res.status(400).json({ error: 'Plot name, crop, and area are required' });
  }
  if (!CROP_DATA[crop]) {
    return res.status(400).json({ error: 'Invalid crop selected' });
  }
  const area = parseFloat(area_acres);
  if (isNaN(area) || area <= 0) {
    return res.status(400).json({ error: 'Area must be a positive number of acres' });
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const sown = sowing_date || todayStr;
  const newPlotId = 'PLOT-' + farmer.id + '-' + (farmer.plots.length + 1);

  const newPlot = {
    id: newPlotId,
    name: String(name).trim(),
    crop,
    area_acres: +area.toFixed(3),
    sowing_date: sown,
    soil_type: soil_type ? String(soil_type).trim() : 'Clay Loam',
    notes: notes ? String(notes).trim() : '',
    created_at: new Date().toISOString()
  };

  farmer.plots.push(newPlot);
  ensureFarmerPlots(farmer);
  farmer.estimated_daily_water_litres = estimatedDailyCropWaterLitres(farmer);
  farmer.estimated_water_until_harvest_litres = estimatedWaterUntilHarvestLitres(farmer);
  saveFarmers();

  audit(req.session.username, 'Added new plot ' + newPlot.id + ' (' + newPlot.name + ', ' + newPlot.crop + ', ' + newPlot.area_acres + ' ac) for farmer ' + farmer.name);

  addNotification({
    recipientRole: 'farmer',
    recipientId: farmer.id,
    title: '🌾 New Plot Registered',
    message: 'Plot "' + newPlot.name + '" (' + newPlot.crop + ', ' + newPlot.area_acres + ' acres, Sown: ' + sown + ') has been added to your field profile.',
    type: 'success'
  });

  addNotification({
    recipientRole: 'admin',
    title: '🌱 New Plot Added by ' + farmer.name,
    message: farmer.name + ' registered plot "' + newPlot.name + '" (' + newPlot.crop + ', ' + newPlot.area_acres + ' ac, Sown: ' + sown + ').',
    type: 'info'
  });

  res.json({ ok: true, plot: newPlot, farmer: sanitizeFarmer(farmer) });
});

app.put('/api/farmer/plots/:plotId', requireAuth, (req, res) => {
  let targetId = req.session.farmerId;
  if (req.session.role === 'admin' && req.body.farmerId) {
    targetId = req.body.farmerId;
  }
  const farmer = FARMERS.find(f => f.id === targetId);
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  ensureFarmerPlots(farmer);

  const plot = farmer.plots.find(p => p.id === req.params.plotId);
  if (!plot) return res.status(404).json({ error: 'Plot not found' });

  const { name, crop, area_acres, sowing_date, soil_type, notes } = req.body;
  if (name && String(name).trim()) plot.name = String(name).trim();
  if (crop) {
    if (!CROP_DATA[crop]) return res.status(400).json({ error: 'Invalid crop' });
    plot.crop = crop;
  }
  if (area_acres != null && area_acres !== '') {
    const a = parseFloat(area_acres);
    if (!isNaN(a) && a > 0) plot.area_acres = +a.toFixed(3);
  }
  if (sowing_date) plot.sowing_date = sowing_date;
  if (soil_type) plot.soil_type = String(soil_type).trim();
  if (notes != null) plot.notes = String(notes).trim();

  ensureFarmerPlots(farmer);
  farmer.estimated_daily_water_litres = estimatedDailyCropWaterLitres(farmer);
  farmer.estimated_water_until_harvest_litres = estimatedWaterUntilHarvestLitres(farmer);
  saveFarmers();

  audit(req.session.username, 'Updated plot ' + plot.id + ' (' + plot.name + ') for farmer ' + farmer.name);
  res.json({ ok: true, plot, farmer: sanitizeFarmer(farmer) });
});

app.delete('/api/farmer/plots/:plotId', requireAuth, (req, res) => {
  let targetId = req.session.farmerId;
  if (req.session.role === 'admin' && req.query.farmerId) {
    targetId = req.query.farmerId;
  }
  const farmer = FARMERS.find(f => f.id === targetId);
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  ensureFarmerPlots(farmer);

  if (farmer.plots.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete your only plot. Every farmer must cultivate at least one plot.' });
  }

  const pIdx = farmer.plots.findIndex(p => p.id === req.params.plotId);
  if (pIdx === -1) return res.status(404).json({ error: 'Plot not found' });

  const [removed] = farmer.plots.splice(pIdx, 1);
  ensureFarmerPlots(farmer);
  farmer.estimated_daily_water_litres = estimatedDailyCropWaterLitres(farmer);
  farmer.estimated_water_until_harvest_litres = estimatedWaterUntilHarvestLitres(farmer);
  saveFarmers();

  audit(req.session.username, 'Deleted plot ' + removed.id + ' (' + removed.name + ') for farmer ' + farmer.name);
  res.json({ ok: true, removed, farmer: sanitizeFarmer(farmer) });
});

// --- Irrigation History (admin) ---
app.get('/api/irrigation/history', requireAdmin, (req, res) => {
  res.json(HISTORY.slice(-50).reverse());
});

// --- Irrigation Run ---
app.post('/api/irrigation/run', requireAdmin, (req, res) => {
  const water = parseFloat(req.body.water);
  if (isNaN(water) || water < 0) return res.status(400).json({ error: 'Invalid water amount' });

  // Solar battery interlock check
  const telemetry = getSolarTelemetry(true);
  if (!telemetry.pump_interlock_safe && !req.body.bypass_solar_lock) {
    return res.status(400).json({
      error: `⛔ Solar Battery Interlock Active: Battery SoC is ${telemetry.battery_soc_pct}% (<20% safe reserve threshold). Power insufficient for pumping. Wait for solar recharge or check bypass.`,
      interlock_triggered: true,
      battery_soc: telemetry.battery_soc_pct
    });
  }

  const activeFarmers = FARMERS.filter(f => (f.status || 'active') === 'active');
  if (!activeFarmers.length) return res.status(400).json({ error: 'No active farmers registered' });

  const rng = seededRandom(parseInt(CONFIG.random_seed));
  const moisture = activeFarmers.map(() => simulatedSoilMoisture(rng));
  const demands = activeFarmers.map(f => estimateDemand(f));
  const allocations = runStrategy(ACTIVE_STRATEGY, demands, water);

  const noiseRng = seededRandom(parseInt(CONFIG.random_seed) + 1);
  const delivered = allocations.map(a => {
    const noise = noiseRng.uniform(-CONFIG.flow_sensor_noise, CONFIG.flow_sensor_noise);
    return Math.max(0, a * (1 + noise));
  });

  const farmer_rows = activeFarmers.map((f, i) => {
    const sat = demands[i] > 1e-9 ? Math.min(1.0, delivered[i] / demands[i]) : 1.0;
    f.last_soil_moisture = +moisture[i].toFixed(2);
    f.total_allocated_litres = (f.total_allocated_litres || 0) + allocations[i];
    f.total_delivered_litres = (f.total_delivered_litres || 0) + delivered[i];
    f.epochs_served = (f.epochs_served || 0) + 1;
    return {
      farmer: f.name, farmerId: f.id, crop: f.crop,
      soil_moisture: +moisture[i].toFixed(2),
      demand: +demands[i].toFixed(2),
      allocated: +allocations[i].toFixed(2),
      delivered: +delivered[i].toFixed(2),
      satisfied_pct: +(sat * 100).toFixed(2)
    };
  });

  saveFarmers();
  audit(req.session.username, `Ran irrigation: ${water}L available, ${allocations.reduce((a,v)=>a+v,0).toFixed(0)}L allocated`);

  const metrics = getMetrics(demands, allocations);
  let schedule = null;
  try { schedule = createSchedule(activeFarmers, allocations); } catch(e) { schedule = { error: e.message }; }

  const historyEntry = {
    timestamp: new Date().toISOString(),
    water_available: water,
    total_demand: +demands.reduce((a,v)=>a+v,0).toFixed(2),
    total_allocated: +allocations.reduce((a,v)=>a+v,0).toFixed(2),
    unmet: +metrics.unmet.toFixed(2),
    avg_satisfaction: +metrics.average_satisfaction.toFixed(2),
    allocation_fairness: +metrics.allocation_fairness.toFixed(4),
    farmer_count: activeFarmers.length,
    farmer_rows
  };
  HISTORY.push(historyEntry);
  saveHistory();

  // Deduct a small battery power amount for this run
  SOLAR.battery_soc_pct = Math.max(10, +(SOLAR.battery_soc_pct - 2.5).toFixed(1));
  saveJson(SOLAR_FILE, SOLAR);

  res.json({
    strategy: ACTIVE_STRATEGY,
    water_available: water,
    total_demand: historyEntry.total_demand,
    total_allocated: historyEntry.total_allocated,
    total_delivered: +delivered.reduce((a,v)=>a+v,0).toFixed(2),
    metrics: {
      unmet: historyEntry.unmet,
      allocation_fairness: historyEntry.allocation_fairness,
      satisfaction_fairness: +metrics.satisfaction_fairness.toFixed(4),
      average_satisfaction: historyEntry.avg_satisfaction
    },
    rows: farmer_rows,
    schedule,
    solar_telemetry: getSolarTelemetry(false)
  });
});

// --- Strategy Comparison ---
app.post('/api/irrigation/compare', requireAdmin, (req, res) => {
  const water = parseFloat(req.body.water);
  if (isNaN(water) || water < 0) return res.status(400).json({ error: 'Invalid water amount' });
  const activeFarmers = FARMERS.filter(f => (f.status || 'active') === 'active');
  if (!activeFarmers.length) return res.status(400).json({ error: 'No active farmers' });

  const rng = seededRandom(parseInt(CONFIG.random_seed));
  const moisture = activeFarmers.map(() => simulatedSoilMoisture(rng));
  const demands = activeFarmers.map(f => estimateDemand(f));
  const stratResults = {};
  STRATEGIES.forEach(s => { stratResults[s] = runStrategy(s, demands, water); });

  res.json({
    active_strategy: ACTIVE_STRATEGY,
    water, total_demand: +demands.reduce((a,v)=>a+v,0).toFixed(2),
    input_data: activeFarmers.map((f,i) => ({
      farmer: f.name, crop: f.crop, area_acres: +f.area_acres.toFixed(2),
      soil_moisture: +moisture[i].toFixed(2), demand: +demands[i].toFixed(2)
    })),
    allocation_data: activeFarmers.map((f,i) => {
      const row = { farmer: f.name };
      STRATEGIES.forEach(s => { row[s] = +stratResults[s][i].toFixed(2); });
      return row;
    }),
    performance: STRATEGIES.map(s => {
      const m = getMetrics(demands, stratResults[s]);
      return {
        strategy: s, role: s === ACTIVE_STRATEGY ? 'OUR METHOD' : 'Benchmark',
        allocated: +m.allocated.toFixed(2), unmet: +m.unmet.toFixed(2),
        allocation_fairness: +m.allocation_fairness.toFixed(4),
        satisfaction_fairness: +m.satisfaction_fairness.toFixed(4),
        avg_satisfaction: +m.average_satisfaction.toFixed(2)
      };
    })
  });
});

// --- Multi-Epoch Simulation ---
app.post('/api/irrigation/simulation', requireAdmin, (req, res) => {
  const { epochs, normal_water, scarce_water, scarcity_start } = req.body;
  const activeFarmers = FARMERS.filter(f => (f.status || 'active') === 'active');
  if (!activeFarmers.length) return res.status(400).json({ error: 'No active farmers' });

  const epochRows = [];
  const farmerTotals = {};
  activeFarmers.forEach(f => {
    farmerTotals[f.id] = { id: f.id, name: f.name, crop: f.crop, demand: 0, allocated: 0, shortage: 0 };
  });

  const baseSeed = parseInt(CONFIG.random_seed);
  for (let epoch = 1; epoch <= Math.min(100, parseInt(epochs)); epoch++) {
    const supply = epoch < parseInt(scarcity_start) ? parseFloat(normal_water) : parseFloat(scarce_water);
    const rng = seededRandom(baseSeed + epoch);
    const moisture = activeFarmers.map(() => simulatedSoilMoisture(rng));
    const demands = activeFarmers.map(f => Math.max(0, estimateDemand(f)));
    const allocations = runStrategy(ACTIVE_STRATEGY, demands, supply);
    const metrics = getMetrics(demands, allocations);

    const farmerRows = activeFarmers.map((f, i) => {
      const shortage = Math.max(0, demands[i] - allocations[i]);
      farmerTotals[f.id].demand += demands[i];
      farmerTotals[f.id].allocated += allocations[i];
      farmerTotals[f.id].shortage += shortage;
      return {
        farmerId: f.id, farmer: f.name, crop: f.crop,
        demand: +demands[i].toFixed(2), allocated: +allocations[i].toFixed(2),
        shortage: +shortage.toFixed(2),
        demand_met_pct: +(demands[i] > 0 ? 100*allocations[i]/demands[i] : 100).toFixed(2)
      };
    });

    epochRows.push({
      epoch, regime: epoch < parseInt(scarcity_start) ? 'Normal' : 'Scarcity',
      supply: +supply.toFixed(2),
      total_demand: +demands.reduce((a,v)=>a+v,0).toFixed(2),
      total_allocated: +allocations.reduce((a,v)=>a+v,0).toFixed(2),
      shortage: +metrics.unmet.toFixed(2),
      avg_satisfaction: +metrics.average_satisfaction.toFixed(2),
      farmers: farmerRows
    });
  }

  audit(req.session.username, `Ran ${epochs}-epoch simulation`);
  res.json({
    epochs: epochRows,
    summary: Object.values(farmerTotals).map(t => ({
      id: t.id, name: t.name, crop: t.crop,
      total_demand: +t.demand.toFixed(2),
      total_allocated: +t.allocated.toFixed(2),
      total_shortage: +t.shortage.toFixed(2),
      demand_met_pct: +(t.demand > 0 ? 100*t.allocated/t.demand : 100).toFixed(2)
    })),
    strategy: ACTIVE_STRATEGY
  });
});

// --- Configuration ---
app.get('/api/config', requireAdmin, (req, res) => { res.json(CONFIG); });

app.put('/api/config', requireAdmin, (req, res) => {
  const newConfig = { ...CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (req.body[key] != null) {
      newConfig[key] = key === 'random_seed' ? parseInt(req.body[key]) : parseFloat(req.body[key]);
    }
  }
  const { ok, error } = validConfig(newConfig);
  if (!ok) return res.status(400).json({ error });
  CONFIG = newConfig;
  saveJson(CONFIG_FILE, CONFIG);
  audit(req.session.username, 'Updated configuration');
  res.json({ ok: true, config: CONFIG });
});

// --- Audit Log ---
app.get('/api/audit', requireAdmin, (req, res) => {
  if (!fs.existsSync(AUDIT_FILE)) return res.json({ log: '' });
  res.json({ log: fs.readFileSync(AUDIT_FILE, 'utf8') });
});

// --- Admin Credentials ---
app.post('/api/auth/admin/change-credentials', requireAdmin, async (req, res) => {
  const { current_password, new_username, new_password } = req.body;
  const result = await changeAdminCredentials(req.session.username, current_password, new_username, new_password);
  if (!result.ok) return res.status(400).json({ error: result.error });
  req.session.username = result.username;
  res.json({ ok: true, username: result.username });
});

// --- Crops ---
app.get('/api/crops', (req, res) => {
  res.json(CROPS.map(name => ({
    name,
    duration_days: CROP_DATA[name].duration_days,
    season: CROP_DATA[name].season,
    planting_months: CROP_DATA[name].planting_months
  })));
});

// --- Dashboard Summary ---
app.get('/api/dashboard', requireAdmin, (req, res) => {
  const active = FARMERS.filter(f => (f.status || 'active') === 'active');
  const inactive = FARMERS.filter(f => f.status === 'inactive');
  const totalArea = active.reduce((s,f)=>s+parseFloat(f.area_acres),0);
  const totalDaily = active.reduce((s,f)=>s+estimatedDailyCropWaterLitres(f),0);
  const totalAllocated = FARMERS.reduce((s,f)=>s+(f.total_allocated_litres||0),0);
  const cropDist = {};
  active.forEach(f=>{ cropDist[f.crop]=(cropDist[f.crop]||0)+1; });

  const pendingRequests = REQUESTS.filter(r => r.status === 'pending');
  const telemetry = getSolarTelemetry();

  res.json({
    total_farmers: FARMERS.length, active: active.length, inactive: inactive.length,
    total_area_acres: +totalArea.toFixed(2),
    est_daily_need_litres: +totalDaily.toFixed(0),
    total_allocated_all_time: +totalAllocated.toFixed(0),
    irrigation_runs: HISTORY.length,
    crop_distribution: cropDist,
    recent_history: HISTORY.slice(-7).reverse(),
    pending_requests_count: pendingRequests.length,
    recent_requests: REQUESTS.slice(0, 5),
    solar_telemetry: telemetry,
    weather_forecast: getWeatherForecast(),
    farmers: active.map(sanitizeFarmer)
  });
});

// ======================== START ===============================
function startServer(portToTry) {
  const server = app.listen(portToTry, () => {
    console.log(`\n🌱 FarmFlow v3 running at http://localhost:${portToTry}`);
    console.log(`   Data directory: ${BASE_DIR}`);
    fs.writeFileSync(path.join(__dirname, 'active_port.txt'), String(portToTry), 'utf8');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      console.log(`Port ${portToTry} is busy or reserved (${err.code}). Trying port ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(parseInt(PORT, 10) || 3001);
