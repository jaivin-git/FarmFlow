# 🌾 FarmFlow: Solar-Powered Adaptive Irrigation & Nash Bargaining System

An intelligent, cooperative smart-irrigation and microgrid platform designed for distributed canal irrigation networks, powered by solar PV arrays and game-theoretic resource allocation.

FarmFlow bridges the gap between field-level agricultural physics, solar energy availability, and cooperative multi-farmer water distribution.

---

## 🌟 Key Features

### 1. ☀️ Solar PV & Battery Microgrid Monitoring
* Real-time tracking of solar irradiance ($W/m^2$), photovoltaic generation (Watts), and battery state-of-charge (SoC).
* Automated pump power interlock protecting battery reserves from deep discharge during cloudy spells.
* Best free solar pumping window identification (10:00 AM – 3:30 PM).

### 2. 🤝 Need-Weighted Nash Bargaining Solution
* Solves the tragedy of the commons in shared village canal irrigation.
* Cooperative game theory allocates available water among farmers based on:
  * Crop type & root growth stage coefficients ($K_c$)
  * Dynamic root zone soil moisture depletion
  * Field acreage and cumulative irrigation satisfaction history
* Maximizes the Nash product $\prod (U_i - d_i)^{w_i}$ to ensure mathematical fairness and pareto efficiency.

### 3. 🧑‍🌾 Curated Farmer Self-Service Portal
* **Practical Weather Forecast**: Plain-language weather observations (temperature, air moisture, wind, daily rainfall, sunlight availability) without engineering jargon.
* **Plot Water Line & Valve Status**: Visual pipeline connectivity from the canal pump to the farmer's plot valve with a one-click valve response test pulse.
* **Root Zone Soil Health Dial**: Intuitive soil moisture gauge with clear risk thresholds (*Too Dry*, *Moderate*, *Ideal Moisture*, *Saturated*).
* **On-Demand Water Requests**: Farmers can request normal or emergency water delivery with coordinator notification.
* **Agronomic Audio Assistant**: Web Speech API audio narration offering daily agricultural advice.

### 4. ⚙️ Edge Coordinator / Admin Dashboard
* **Canal & Valve Hydraulic Digital Twin**: Live hydraulic simulation with 5HP pump impeller RPM, line pressure (bar), head loss (m), friction loss, and solenoid valve manifold.
* **Dual-Engine Visualization**: High-performance Chart.js analytics with native SVG fallback for 100% rendering reliability across all network conditions.
* **Farmer Management & Security**: Role-based access control, bcrypt password protection, status toggles, and downloadable official irrigation delivery slips.
* **Audit Trail**: Real-time logging of all coordinator actions, weather changes, and distribution cycles.

---

## 🏗️ Architecture & Technology Stack

* **Backend**: Node.js & Express with session authentication and file-persisted JSON datastore.
* **Frontend**: Vanilla JavaScript (ES6+), responsive CSS3 design, Chart.js, and native SVG graphics.
* **Hydraulic Simulator**: Python / Node analytical solvers modeling canal flow, pressure head, and distribution mechanics.
* **Agronomic Modeling**: FAO-56 Penman-Monteith reference evapotranspiration ($ET_0$) and crop water requirement equations ($ET_c = ET_0 \times K_c$).

---

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org) (v16 or newer)
* [Git](https://git-scm.com)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/jaivin-git/FarmFlow.git
   cd FarmFlow
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the application**:
   * **Windows Quick-Launch**:
     Double-click `start.bat` to automatically start the backend server and open the web app in your default browser.
   * **Manual Launch**:
     ```bash
     node server.js
     ```
     Then navigate to `http://localhost:3001` in your browser.

---

## 🔐 Default Access & Credentials

* **Edge Coordinator (Admin)**:
  * Username: `jaivin`
  * Default Password: `password`
* **Farmer Self-Service**:
  * Farmer ID: `JAI101`
  * Default Password: `password` (or password configured in Admin panel)

---

## 📄 License
This project is open-source and available under the [MIT License](LICENSE).
