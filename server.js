/* =====================================================================
   EcoSim - A Miniature Smart City Simulator  (single master file)
   Stack: Node.js + Express + MongoDB Atlas (Mongoose) + Bootstrap 5
   Run:   npm install   then   npm start   ->  http://localhost:3000
   NOTE:  Results are estimates from predefined assumptions, not
          real-world environmental measurements.
   ===================================================================== */
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ecosim-dev-secret';
const MONGO_URI = process.env.MONGO_URI;

/* ------------------------- SIMULATION ENGINE -------------------------
   Pure function, used by the server (when saving) AND sent to the
   browser (/sim.js) so the dashboard updates live with identical maths.
   Assumptions (city area = 1000 ha):
   - petrol/diesel vehicle emits 6 kg CO2/day; building 150 kg CO2/day
   - solar panel = 1.6 kWh/day; building uses 1200 kWh/day; EV 7 kWh/day
   - grid emission factor 0.7 kg CO2/kWh; tree absorbs 0.06 kg CO2/day
   - green space absorbs 40 kg CO2/day per hectare; tree canopy = 25 m2
------------------------------------------------------------------------ */
function simulate(p) {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const AREA_HA = 1000;
  const evVehicles = p.vehicles * p.ev / 100;
  const effective = p.vehicles * (1 - p.transit / 200);
  const congestion = clamp(effective / 12000 * 100, 0, 100);

  const vehCO2 = (p.vehicles - evVehicles) * 6;
  const bldCO2 = p.buildings * 150;
  const gross = vehCO2 + bldCO2;

  const solarKwh = p.solar * 1.6;
  const demandKwh = p.buildings * 1200 + evVehicles * 7;
  const renewable = demandKwh > 0 ? clamp(solarKwh / demandKwh * 100, 0, 100) : 0;
  const solarOffset = Math.min(solarKwh, demandKwh) * 0.7;
  const absorbed = p.trees * 0.06 + p.green * 40;
  const netCO2 = gross - solarOffset - absorbed;

  const pollution = clamp(Math.max(netCO2, 0) / 120000 * 100, 0, 100);
  const greenery = clamp((p.green * 10000 + p.trees * 25) / (AREA_HA * 10000) * 100, 0, 100);

  const score = Math.round(
    (100 - congestion) * 0.2 +
    (100 - pollution) * 0.3 +
    renewable * 0.25 +
    Math.min(100, greenery / 25 * 100) * 0.25
  );
  const status = score >= 70 ? 'Thriving' : score >= 50 ? 'Balanced' : score >= 30 ? 'Strained' : 'Critical';

  const tips = [];
  if (congestion > 60) tips.push('Traffic is heavy. Raise the public transit share or cut vehicle numbers.');
  if (p.ev < 40 && p.vehicles > 3000) tips.push('Most vehicles still burn fuel. Moving more of them to electric cuts emissions fast.');
  if (renewable < 25) tips.push('Solar covers little of the demand. Add panels to lift renewable energy.');
  if (greenery < 10) tips.push('Greenery is low. More trees and green spaces absorb CO2 and cool the city.');
  if (pollution > 60) tips.push('Pollution is high. Buildings and vehicles are the largest sources, so target those first.');
  if (!tips.length) tips.push('This layout is well balanced. Try pushing renewable energy and greenery even higher.');

  const r = (v, d) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
  return {
    congestion: r(congestion, 1), pollution: r(pollution, 1), renewable: r(renewable, 1),
    greenery: r(greenery, 1), score: score, status: status,
    grossCO2: Math.round(gross), netCO2: Math.round(netCO2), absorbedCO2: Math.round(absorbed),
    solarKwh: Math.round(solarKwh), demandKwh: Math.round(demandKwh), evVehicles: Math.round(evVehicles),
    tips: tips
  };
}

/* ----------------------------- MODELS ------------------------------ */
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true,
           match: [/^\S+@\S+\.\S+$/, 'Enter a valid email address'] },
  password: { type: String, required: true }
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const num = (min, max, def) => ({ type: Number, min: min, max: max, default: def, required: true });
const citySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  params: {
    vehicles: num(0, 20000, 6000), ev: num(0, 100, 15), transit: num(0, 100, 25),
    buildings: num(0, 1000, 300), trees: num(0, 100000, 15000),
    solar: num(0, 150000, 8000), green: num(0, 200, 40)
  },
  results: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });
const City = mongoose.model('City', citySchema);

/* ----------------------------- SERVER ------------------------------ */
const app = express();
app.use(express.json());

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  const msg = err.code === 11000 ? 'That email is already registered.'
    : err.name === 'ValidationError' ? Object.values(err.errors).map(e => e.message).join(' ')
    : err.message;
  res.status(400).json({ error: msg });
});

const sign = u => jwt.sign({ id: u._id }, JWT_SECRET, { expiresIn: '7d' });
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try { req.userId = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET).id; next(); }
  catch (e) { res.status(401).json({ error: 'Please log in again.' }); }
}

// Auth
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
  const user = await User.create({ name, email, password: await bcrypt.hash(password, 10) });
  res.status(201).json({ token: sign(user), user: { name: user.name, email: user.email } });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email || '').toLowerCase().trim() });
  if (!user || !(await bcrypt.compare(req.body.password || '', user.password)))
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json({ token: sign(user), user: { name: user.name, email: user.email } });
}));

// City configurations (CRUD)
app.get('/api/cities', auth, wrap(async (req, res) => {
  res.json(await City.find({ user: req.userId }).sort({ updatedAt: -1 }));
}));
app.post('/api/cities', auth, wrap(async (req, res) => {
  const city = new City({ user: req.userId, name: req.body.name, params: req.body.params });
  city.results = simulate(city.params.toObject());
  await city.save();
  res.status(201).json(city);
}));
app.put('/api/cities/:id', auth, wrap(async (req, res) => {
  const city = await City.findOne({ _id: req.params.id, user: req.userId });
  if (!city) return res.status(404).json({ error: 'City not found.' });
  city.name = req.body.name; city.params = req.body.params;
  city.results = simulate(city.params.toObject());
  await city.save();
  res.json(city);
}));
app.delete('/api/cities/:id', auth, wrap(async (req, res) => {
  const del = await City.findOneAndDelete({ _id: req.params.id, user: req.userId });
  if (!del) return res.status(404).json({ error: 'City not found.' });
  res.json({ ok: true });
}));

// Frontend
app.get('/sim.js', (req, res) => res.type('js').send('const simulate = ' + simulate.toString() + ';'));
app.get('/', (req, res) => res.type('html').send(PAGE));

mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 })
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log('EcoSim running at http://localhost:' + PORT));
  })
  .catch(err => {
    console.error('\nCould not connect to MongoDB: ' + err.message);
    console.error('Check MONGO_URI in the .env file and that your IP is allowed in Atlas > Network Access.\n');
    process.exit(1);
  });

/* ---------------------------- FRONTEND ----------------------------- */
// (No backticks or dollar-braces inside this block, so it stays a plain string.)
const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EcoSim - Miniature Smart City Simulator</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;700;800&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#e7eeea;--ink:#12302f;--muted:#5b716f;--panel:#fff;--line:#cfdcd7;--green:#2f7d6b;--amber:#d9822b;--red:#c2453d;--blue:#3b7ea1}
body{background:var(--bg);color:var(--ink);font-family:'DM Sans',sans-serif;min-height:100vh}
h1,h2,h3,h4,h5,.brand{font-family:'Bricolage Grotesque',sans-serif;letter-spacing:-.01em}
.btn-eco{background:var(--ink);color:#fff;border:0;border-radius:8px;font-weight:700;padding:.6rem 1.1rem}
.btn-eco:hover{background:var(--green);color:#fff}
.btn-line{border:1px solid var(--line);background:#fff;border-radius:8px;color:var(--ink);font-weight:500}
.btn-line:hover{border-color:var(--ink)}
.form-control{border-radius:8px;border-color:var(--line)}
.form-control:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(47,125,107,.2)}
:focus-visible{outline:3px solid var(--green);outline-offset:2px}
/* auth */
#authView{min-height:100vh;transition:opacity .35s}
#authView.leaving{opacity:0}
.auth-art{background:#0d2a2b;color:#e7eeea;padding:3rem;display:flex;flex-direction:column;gap:2rem;position:relative;overflow:hidden;min-height:340px}
.auth-art>*:not(canvas){position:relative;z-index:1}
#authCanvas{position:absolute;inset:0;width:100%;height:100%}
.auth-art h1{font-size:clamp(2.2rem,4vw,3.4rem);font-weight:800;line-height:1.05;max-width:14ch}
.auth-art p{color:#a8c4bd;max-width:38ch}
.auth-box{max-width:400px;width:100%}
.tabs button{background:none;border:0;border-bottom:3px solid transparent;font-weight:700;color:var(--muted);padding:.4rem .2rem;margin-right:1.2rem;transition:color .2s,border-color .2s}
.tabs button.on{color:var(--ink);border-color:var(--green)}
.field{position:relative}
.field .form-control{transition:border-color .2s,box-shadow .2s,transform .2s}
.field .form-control:focus{transform:translateY(-1px)}
#authGo{transition:background .2s,transform .15s}
#authGo:active{transform:scale(.98)}
#authGo.busy{pointer-events:none;opacity:.7}
.shake{animation:shake .4s}
@keyframes shake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
/* app */
.topbar{background:var(--ink);color:#fff}
.brand{font-weight:800;font-size:1.3rem}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1.1rem}
.side{position:sticky;top:1rem}
.ctl{margin-bottom:.9rem}
.ctl label{font-weight:500;font-size:.92rem;margin:0}
.ctl .num{width:98px;text-align:right;font-weight:700;color:var(--green);padding:.15rem .4rem}
input[type=range]{width:100%;accent-color:var(--green)}
.presets{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem}
.presets button{font-size:.8rem;padding:.25rem .6rem}
#sky{width:100%;height:auto;border-radius:12px;display:block;border:1px solid var(--line)}
.kpi{border-left:4px solid var(--green);padding:.2rem .8rem;transition:border-color .4s}
.kpi small{color:var(--muted);display:block}
.kpi b{font-family:'Bricolage Grotesque',sans-serif;font-size:1.7rem;line-height:1.1;font-variant-numeric:tabular-nums}
.kpi span{font-size:.8rem;color:var(--muted)}
.scorebar{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap}
.score-n{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-size:3rem;line-height:1;font-variant-numeric:tabular-nums}
.pill{padding:.2rem .7rem;border-radius:99px;font-weight:700;font-size:.85rem;color:#fff;transition:background .4s}
.tips li{margin-bottom:.35rem}
.city-row{display:flex;align-items:center;gap:.6rem;padding:.55rem 0;border-bottom:1px solid var(--line)}
.city-row:last-child{border:0}
.city-row .nm{flex:1;min-width:0}
.city-row .nm b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.city-row .nm small{color:var(--muted)}
table.cmp{width:100%;font-size:.9rem}
table.cmp th,table.cmp td{padding:.35rem .5rem;border-bottom:1px solid var(--line)}
table.cmp th{font-weight:700}
.nav-links button{background:none;border:0;color:#a8c4bd;font-weight:500;padding:.35rem .7rem;border-bottom:2px solid transparent}
.nav-links button:hover{color:#fff}
.nav-links button.on{color:#fff;border-color:#5fd0a5}
.grid-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:.7rem}
.grid-list .city-row{border:1px solid var(--line);border-radius:10px;padding:.7rem}
label.city-row{cursor:pointer}
.best{color:var(--green);font-weight:700}
.step{border-top:3px solid var(--green);padding-top:.7rem}
.wbar{height:12px;border-radius:6px;background:var(--green)}
.toast-box{position:fixed;right:1rem;bottom:1rem;z-index:99}
@media (prefers-reduced-motion:no-preference){
.fadein{animation:f .4s ease}@keyframes f{from{opacity:0}to{opacity:1}}
.rise{animation:rise .7s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--d,0s)}
@keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
.pop{animation:pop .35s ease}@keyframes pop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:none}}
}
</style>
</head>
<body>

<!-- LOGIN / REGISTER -->
<div id="authView" class="row g-0">
  <div class="col-lg-6 auth-art">
    <canvas id="authCanvas" aria-hidden="true"></canvas>
    <div class="brand rise">EcoSim</div>
    <div>
      <h1 class="rise" style="--d:.15s">Test a city before you build it.</h1>
      <p class="mt-3 rise" style="--d:.3s">Change vehicles, buildings, trees and solar panels, then watch traffic, pollution and renewable energy respond.</p>
      <small class="rise d-block" style="--d:.45s;color:#7fa39a">Educational prototype. Results are estimates, not real measurements.</small>
    </div>
  </div>
  <div class="col-lg-6 d-flex align-items-center justify-content-center p-4">
    <div class="auth-box" id="authBox">
      <div class="tabs mb-3 rise" style="--d:.2s">
        <button id="tabLogin" class="on" type="button">Log in</button>
        <button id="tabReg" type="button">Create account</button>
      </div>
      <div id="authErr" class="alert alert-danger py-2 d-none"></div>
      <div id="nameWrap" class="mb-3 d-none field"><label class="form-label">Name</label><input id="aName" class="form-control" autocomplete="name"></div>
      <div class="mb-3 field rise" style="--d:.3s"><label class="form-label">Email</label><input id="aEmail" type="email" class="form-control" autocomplete="email"></div>
      <div class="mb-3 field rise" style="--d:.4s"><label class="form-label">Password</label><input id="aPass" type="password" class="form-control" autocomplete="current-password"></div>
      <button id="authGo" class="btn btn-eco w-100 rise" style="--d:.5s" type="button">Log in</button>
    </div>
  </div>
</div>

<!-- DASHBOARD -->
<div id="appView" class="d-none">
  <div class="topbar py-2 px-3 d-flex align-items-center justify-content-between flex-wrap gap-2">
    <div class="d-flex align-items-center gap-4 flex-wrap">
      <div class="brand">EcoSim</div>
      <nav class="nav-links" aria-label="Main">
        <button type="button" data-page="dash" class="on">Dashboard</button>
        <button type="button" data-page="compare">Compare</button>
        <button type="button" data-page="learn">How it works</button>
      </nav>
    </div>
    <div class="d-flex align-items-center gap-3"><span id="who" class="small"></span>
      <button id="logout" class="btn btn-sm btn-line" type="button">Log out</button></div>
  </div>

  <div id="page_dash" class="container-fluid p-3 p-lg-4">
    <div class="row g-3">
      <div class="col-lg-4 col-xl-3">
        <div class="panel side">
          <h5 class="mb-3">City layout</h5>
          <div class="mb-3"><label class="form-label small mb-1">City name</label><input id="cName" class="form-control" value="My new city" maxlength="60"></div>
          <div class="small text-muted mb-1">Quick start</div>
          <div class="presets">
            <button type="button" class="btn btn-line" data-preset="car">Car city</button>
            <button type="button" class="btn btn-line" data-preset="balanced">Balanced</button>
            <button type="button" class="btn btn-line" data-preset="eco">Eco city</button>
          </div>
          <div class="small text-muted mb-2">Drag a slider or type an exact value.</div>
          <div id="controls"></div>
          <div class="d-grid gap-2 mt-3">
            <button id="saveBtn" class="btn btn-eco" type="button">Save city</button>
            <button id="copyBtn" class="btn btn-line d-none" type="button">Save as new copy</button>
            <button id="newBtn" class="btn btn-line" type="button">Start a new city</button>
          </div>
          <div id="editing" class="small text-muted mt-2"></div>
        </div>
      </div>

      <div class="col-lg-8 col-xl-9">
        <canvas id="sky" width="1000" height="240" aria-label="Illustration of the city you configured"></canvas>

        <div class="panel mt-3">
          <div class="scorebar">
            <div><small class="text-muted d-block">Sustainability score</small><span id="score" class="score-n">0</span><span class="text-muted"> / 100</span></div>
            <span id="status" class="pill">-</span>
            <div class="ms-auto small text-muted" style="max-width:46ch">Weighted mix of low traffic, low pollution, renewable energy share and greenery.</div>
          </div>
        </div>

        <div class="row g-3 mt-0">
          <div class="col-6 col-xl-3"><div class="panel kpi" id="k1"><small>Traffic congestion</small><b>-</b><span></span></div></div>
          <div class="col-6 col-xl-3"><div class="panel kpi" id="k2"><small>Pollution index</small><b>-</b><span></span></div></div>
          <div class="col-6 col-xl-3"><div class="panel kpi" id="k3"><small>Renewable energy</small><b>-</b><span></span></div></div>
          <div class="col-6 col-xl-3"><div class="panel kpi" id="k4"><small>Greenery</small><b>-</b><span></span></div></div>
        </div>

        <div class="row g-3 mt-0">
          <div class="col-xl-7"><div class="panel h-100"><h6>Indicators (0 to 100)</h6><canvas id="barChart" height="150"></canvas></div></div>
          <div class="col-xl-5">
            <div class="panel h-100">
              <h6>Daily totals</h6>
              <table class="cmp"><tbody id="totals"></tbody></table>
              <h6 class="mt-3">What to improve</h6>
              <ul id="tips" class="tips ps-3 mb-0 small"></ul>
            </div>
          </div>
        </div>

        <div class="panel mt-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h6 class="mb-0">Saved cities</h6>
            <button id="goCompare" class="btn btn-sm btn-line" type="button">Compare cities</button>
          </div>
          <div id="list" class="grid-list"><div class="text-muted small">Loading...</div></div>
        </div>
      </div>
    </div>
  </div>

  <div id="page_compare" class="container-fluid p-3 p-lg-4 d-none">
    <div class="row g-3">
      <div class="col-lg-4 col-xl-3">
        <div class="panel side">
          <h5>Choose cities</h5>
          <p class="small text-muted">Pick two to four. Add your current layout to test a change before you save it.</p>
          <div id="cmpList"></div>
        </div>
      </div>
      <div class="col-lg-8 col-xl-9">
        <div id="cmpEmpty" class="panel text-muted">Select at least two cities on the left to compare them.</div>
        <div id="cmpBody" class="d-none">
          <div class="panel mb-3" id="cmpBanner"></div>
          <div class="row g-3">
            <div class="col-xl-6"><div class="panel h-100"><h6>Overall shape</h6><div class="small text-muted mb-2">Higher is better on every axis.</div><canvas id="cmpChart"></canvas></div></div>
            <div class="col-xl-6"><div class="panel h-100"><h6>Side by side</h6><div style="overflow-x:auto"><table class="cmp" id="cmpTable"></table></div></div></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="page_learn" class="container-fluid p-3 p-lg-4 d-none">
    <div style="max-width:980px;margin:0 auto">
      <h2 class="mb-1">How EcoSim works</h2>
      <p class="text-muted" style="max-width:62ch">EcoSim turns a handful of city settings into estimated sustainability figures. It is a teaching tool, so every number comes from a simple assumption you can read below.</p>

      <div class="row g-3 my-2">
        <div class="col-md-3"><div class="step"><h6>1. Set the layout</h6><p class="small mb-0">Move the sliders or type exact values for vehicles, buildings, trees, solar panels and green space.</p></div></div>
        <div class="col-md-3"><div class="step"><h6>2. The engine calculates</h6><p class="small mb-0">Traffic, emissions, energy and greenery are worked out from your inputs.</p></div></div>
        <div class="col-md-3"><div class="step"><h6>3. Read the dashboard</h6><p class="small mb-0">The skyline, score and charts update instantly, with tips on what to fix.</p></div></div>
        <div class="col-md-3"><div class="step"><h6>4. Save and compare</h6><p class="small mb-0">Store layouts in your account and set them side by side.</p></div></div>
      </div>

      <div class="row g-3 mt-1">
        <div class="col-lg-7">
          <div class="panel h-100">
            <h5>Assumptions used</h5>
            <table class="cmp">
              <tbody>
                <tr><td>City area</td><td class="text-end">1,000 hectares</td></tr>
                <tr><td>Petrol or diesel vehicle</td><td class="text-end">6 kg CO2 per day</td></tr>
                <tr><td>Building</td><td class="text-end">150 kg CO2 and 1,200 kWh per day</td></tr>
                <tr><td>Electric vehicle charging</td><td class="text-end">7 kWh per day</td></tr>
                <tr><td>Solar panel output</td><td class="text-end">1.6 kWh per day</td></tr>
                <tr><td>Grid emissions avoided by solar</td><td class="text-end">0.7 kg CO2 per kWh</td></tr>
                <tr><td>Tree absorption</td><td class="text-end">0.06 kg CO2 per day</td></tr>
                <tr><td>Green space absorption</td><td class="text-end">40 kg CO2 per hectare per day</td></tr>
                <tr><td>Tree canopy</td><td class="text-end">25 m2 each</td></tr>
                <tr><td>Congestion</td><td class="text-end">12,000 effective vehicles = 100%</td></tr>
                <tr><td>Public transit effect</td><td class="text-end">100% use removes half the traffic</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="col-lg-5">
          <div class="panel h-100">
            <h5>How the score is built</h5>
            <p class="small text-muted">Each part is scaled from 0 to 100, then weighted.</p>
            <div class="mb-3"><div class="d-flex justify-content-between small"><span>Pollution (lower is better)</span><b>30%</b></div><div class="wbar" style="width:100%"></div></div>
            <div class="mb-3"><div class="d-flex justify-content-between small"><span>Renewable energy share</span><b>25%</b></div><div class="wbar" style="width:83%"></div></div>
            <div class="mb-3"><div class="d-flex justify-content-between small"><span>Greenery (25% cover = full marks)</span><b>25%</b></div><div class="wbar" style="width:83%"></div></div>
            <div class="mb-3"><div class="d-flex justify-content-between small"><span>Traffic (lower congestion is better)</span><b>20%</b></div><div class="wbar" style="width:67%"></div></div>
            <p class="small mb-0"><b>Status:</b> 70+ Thriving, 50 to 69 Balanced, 30 to 49 Strained, below 30 Critical.</p>
          </div>
        </div>
      </div>

      <div class="panel mt-3">
        <h5>Keep in mind</h5>
        <p class="mb-0 small">These results are estimates from fixed assumptions. They are not real environmental measurements and should not be used for actual planning decisions.</p>
      </div>
    </div>
  </div>
</div>

<div class="toast-box"><div id="toast" class="alert alert-dark py-2 px-3 d-none mb-0"></div></div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<script src="/sim.js"></script>
<script>
var $ = function (id) { return document.getElementById(id); };
var token = localStorage.getItem('ecosim_token');
var cities = [], currentId = null, mode = 'login', barChart = null, cmpChart = null;
var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var FIELDS = [
  { k: 'vehicles',  label: 'Vehicles',               min: 0, max: 20000,  step: 100,  def: 6000 },
  { k: 'ev',        label: 'Electric vehicles (%)',  min: 0, max: 100,    step: 1,    def: 15 },
  { k: 'transit',   label: 'Public transit use (%)', min: 0, max: 100,    step: 1,    def: 25 },
  { k: 'buildings', label: 'Buildings',              min: 0, max: 1000,   step: 10,   def: 300 },
  { k: 'trees',     label: 'Trees',                  min: 0, max: 100000, step: 500,  def: 15000 },
  { k: 'solar',     label: 'Solar panels',           min: 0, max: 150000, step: 500,  def: 8000 },
  { k: 'green',     label: 'Green space (hectares)', min: 0, max: 200,    step: 1,    def: 40 }
];
var PRESETS = {
  car:      { vehicles: 16000, ev: 3,  transit: 5,  buildings: 500, trees: 2000,  solar: 500,   green: 5 },
  balanced: { vehicles: 6000,  ev: 15, transit: 25, buildings: 300, trees: 15000, solar: 8000,  green: 40 },
  eco:      { vehicles: 4000,  ev: 80, transit: 70, buildings: 300, trees: 60000, solar: 60000, green: 120 }
};

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function toast(msg) {
  var t = $('toast'); t.textContent = msg; t.classList.remove('d-none');
  clearTimeout(toast.h); toast.h = setTimeout(function () { t.classList.add('d-none'); }, 2600);
}
function api(path, method, body) {
  return fetch(path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.json().then(function (j) {
      if (r.status === 401 && token) { logout(); }
      if (!r.ok) throw new Error(j.error || 'Request failed');
      return j;
    });
  });
}

/* ---------- animated login scene: a city that wakes up at dawn ---------- */
var authRAF = 0, authDraw = null;
function fitAuth() {
  var c = $('authCanvas'), d = window.devicePixelRatio || 1;
  c.width = c.clientWidth * d; c.height = c.clientHeight * d;
  if (REDUCED && authDraw) authDraw(99999);
}
window.addEventListener('resize', fitAuth);
function startAuthArt() {
  cancelAnimationFrame(authRAF);
  var c = $('authCanvas'), x = c.getContext('2d'), t0 = performance.now(), i, rand = rng(7);
  var B = [], cars = [], clouds = [{ x: .1, y: .1, s: 1 }, { x: .55, y: .2, s: .7 }, { x: .85, y: .08, s: .9 }];
  for (i = 0; i < 16; i++) B.push({ p: i / 16, w: .05 + rand() * .03, h: .2 + rand() * .5, d: 200 + i * 90 + rand() * 200, tone: rand() });
  for (i = 0; i < 6; i++) cars.push({ x: rand(), v: (.03 + rand() * .04) * (i % 2 ? 1 : -1), lane: i % 2, ev: i % 3 === 0 });
  function ease(k) { k = Math.min(1, Math.max(0, k)); return 1 - Math.pow(1 - k, 3); }
  authDraw = function (t) {
    var W = c.width, H = c.height, gy = H * .86, dawn = ease(t / 6000) * .55, k, b, j;
    var g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d2a2b');
    g.addColorStop(1, 'rgb(' + mix(30, 235, dawn) + ',' + mix(70, 150, dawn) + ',' + mix(66, 95, dawn) + ')');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    var sx = W * .72, sy = gy + H * .05 - ease(t / 6000) * H * .42;
    var glow = x.createRadialGradient(sx, sy, 0, sx, sy, H * .4);
    glow.addColorStop(0, 'rgba(255,205,130,.45)'); glow.addColorStop(1, 'rgba(255,205,130,0)');
    x.fillStyle = glow; x.fillRect(0, 0, W, H);
    x.fillStyle = '#ffd89a'; x.beginPath(); x.arc(sx, sy, H * .06, 0, 6.3); x.fill();
    x.fillStyle = 'rgba(255,255,255,.07)';
    clouds.forEach(function (cl) {
      var cx = (((cl.x + t * .000012 * cl.s) % 1.3) - .15) * W, cy = cl.y * H, r = H * .03 * cl.s;
      for (j = 0; j < 4; j++) { x.beginPath(); x.arc(cx + j * r * 1.2, cy - (j % 2) * r * .4, r * (1.1 - j * .1), 0, 6.3); x.fill(); }
    });
    for (k = 0; k < B.length; k++) {
      b = B[k];
      var gr = ease((t - b.d) / 1100), bw = b.w * W, bh = b.h * H * .6 * gr, bx = b.p * W + 2;
      x.fillStyle = 'rgb(' + mix(16, 30, b.tone) + ',' + mix(52, 80, b.tone) + ',' + mix(54, 82, b.tone) + ')';
      x.fillRect(bx, gy - bh, bw, bh);
      for (var wy = gy - bh + 10; wy < gy - 12; wy += 16)
        for (var wx = bx + 6; wx < bx + bw - 10; wx += 13) {
          var on = ((Math.round(wy) * 7 + Math.round(wx) * 3 + k) % 5) > 1 && Math.sin(t / 900 + wy * .1 + wx * .05 + k) > -.5;
          if (on) { x.fillStyle = 'rgba(255,214,140,.7)'; x.fillRect(wx, wy, 5, 8); }
        }
    }
    x.fillStyle = '#0a1f20'; x.fillRect(0, gy, W, H - gy);
    for (k = 0; k < 14; k++) {
      var tx = (k + .5) / 14 * W + Math.sin(t / 700 + k) * 2, tr = H * .022;
      x.fillStyle = '#2f7d6b'; x.beginPath(); x.arc(tx, gy - tr, tr, 0, 6.3); x.fill();
    }
    cars.forEach(function (cr) {
      var cx = (((cr.x + t * cr.v * .0001) % 1) + 1) % 1 * W, cy = gy + (cr.lane ? H * .07 : H * .03);
      x.fillStyle = cr.ev ? '#5fd0a5' : '#d9824b'; x.fillRect(cx, cy, W * .03, H * .02);
    });
  };
  fitAuth();
  if (REDUCED) { authDraw(99999); return; }
  function frame(now) {
    if ($('authView').classList.contains('d-none')) return;
    authDraw(now - t0); authRAF = requestAnimationFrame(frame);
  }
  authRAF = requestAnimationFrame(frame);
}

/* ---------- auth ---------- */
function setMode(m) {
  mode = m;
  $('tabLogin').classList.toggle('on', m === 'login');
  $('tabReg').classList.toggle('on', m === 'register');
  $('nameWrap').classList.toggle('d-none', m === 'login');
  if (m === 'register') { $('nameWrap').classList.remove('pop'); void $('nameWrap').offsetWidth; $('nameWrap').classList.add('pop'); }
  $('authGo').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('authErr').classList.add('d-none');
}
$('tabLogin').onclick = function () { setMode('login'); };
$('tabReg').onclick = function () { setMode('register'); };
function authFail(msg) {
  var e = $('authErr'); e.textContent = msg; e.classList.remove('d-none');
  var b = $('authBox'); b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake');
}
function submitAuth() {
  var body = { email: $('aEmail').value, password: $('aPass').value };
  if (mode === 'register') body.name = $('aName').value;
  var btn = $('authGo'), label = btn.textContent;
  btn.classList.add('busy'); btn.textContent = 'One moment...';
  fetch('/api/auth/' + mode, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); return j; }); })
    .then(function (j) {
      token = j.token; localStorage.setItem('ecosim_token', token);
      localStorage.setItem('ecosim_user', j.user.name);
      btn.textContent = 'Welcome, ' + j.user.name;
      $('authView').classList.add('leaving');
      setTimeout(function () { $('authView').classList.remove('leaving'); btn.classList.remove('busy'); btn.textContent = label; enter(); }, REDUCED ? 0 : 450);
    })
    .catch(function (e) { btn.classList.remove('busy'); btn.textContent = label; authFail(e.message); });
}
$('authGo').onclick = submitAuth;
$('aPass').onkeydown = function (e) { if (e.key === 'Enter') submitAuth(); };
function logout() {
  token = null; localStorage.removeItem('ecosim_token');
  $('appView').classList.add('d-none'); $('authView').classList.remove('d-none'); startAuthArt();
}
$('logout').onclick = logout;

/* ---------- controls: slider + typed value, kept in sync ---------- */
function clampField(f, v) {
  v = Number(v); if (isNaN(v)) v = f.min;
  return Math.min(f.max, Math.max(f.min, Math.round(v)));
}
function buildControls() {
  var h = '';
  FIELDS.forEach(function (f) {
    h += '<div class="ctl"><div class="d-flex justify-content-between align-items-center mb-1">' +
         '<label for="n_' + f.k + '">' + f.label + '</label>' +
         '<input type="number" class="form-control form-control-sm num" id="n_' + f.k + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + f.def + '"></div>' +
         '<input type="range" id="r_' + f.k + '" aria-label="' + f.label + ' slider" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + f.def + '"></div>';
  });
  $('controls').innerHTML = h;
  FIELDS.forEach(function (f) {
    var r = $('r_' + f.k), n = $('n_' + f.k);
    r.oninput = function () { n.value = r.value; render(); };
    n.oninput = function () { if (n.value !== '') { r.value = clampField(f, n.value); render(); } };
    n.onchange = function () { n.value = clampField(f, n.value); r.value = n.value; render(); };
    n.onkeydown = function (e) { if (e.key === 'Enter') n.blur(); };
  });
}
function readParams() {
  var p = {}; FIELDS.forEach(function (f) { p[f.k] = clampField(f, $('n_' + f.k).value); }); return p;
}
function setParams(p) {
  FIELDS.forEach(function (f) { $('n_' + f.k).value = p[f.k]; $('r_' + f.k).value = p[f.k]; });
}
var animId = 0;
function animateTo(target) {
  cancelAnimationFrame(animId);
  if (REDUCED) { setParams(target); render(); return; }
  var from = readParams(), t0 = performance.now();
  function step(now) {
    var k = Math.min(1, (now - t0) / 700), e = 1 - Math.pow(1 - k, 3), p = {};
    FIELDS.forEach(function (f) { p[f.k] = Math.round(from[f.k] + (target[f.k] - from[f.k]) * e); });
    setParams(p); render();
    if (k < 1) animId = requestAnimationFrame(step);
  }
  animId = requestAnimationFrame(step);
}
Array.prototype.forEach.call(document.querySelectorAll('[data-preset]'), function (b) {
  b.onclick = function () { animateTo(PRESETS[b.getAttribute('data-preset')]); };
});

/* ---------- rendering ---------- */
function colorFor(v, goodHigh) {
  var good = goodHigh ? v : 100 - v;
  return good >= 60 ? '#2f7d6b' : good >= 35 ? '#d9822b' : '#c2453d';
}
function fmt(n) { return Number(n).toLocaleString(); }
function animNum(el, to, dec, suf) {
  cancelAnimationFrame(el._r);
  if (REDUCED) { el.textContent = to.toFixed(dec) + suf; el._v = to; return; }
  var from = el._v != null ? el._v : 0, t0 = performance.now();
  function step(now) {
    var k = Math.min(1, (now - t0) / 450), v = from + (to - from) * (1 - Math.pow(1 - k, 3));
    el._v = v; el.textContent = v.toFixed(dec) + suf;
    if (k < 1) el._r = requestAnimationFrame(step);
  }
  el._r = requestAnimationFrame(step);
}

function render() {
  var p = readParams(), r = simulate(p);
  animNum($('score'), r.score, 0, '');
  var s = $('status'); s.textContent = r.status;
  s.style.background = colorFor(r.score, true);
  var ks = [
    ['k1', r.congestion, '%', fmt(Math.round(p.vehicles * (1 - p.transit / 200))) + ' effective vehicles', colorFor(r.congestion, false)],
    ['k2', r.pollution, '', 'Net CO2 ' + fmt(r.netCO2) + ' kg/day', colorFor(r.pollution, false)],
    ['k3', r.renewable, '%', fmt(r.solarKwh) + ' of ' + fmt(r.demandKwh) + ' kWh/day', colorFor(r.renewable, true)],
    ['k4', r.greenery, '%', 'of city area covered', colorFor(Math.min(100, r.greenery / 25 * 100), true)]
  ];
  ks.forEach(function (k) {
    var el = $(k[0]); animNum(el.querySelector('b'), k[1], 1, k[2]);
    el.querySelector('span').textContent = k[3]; el.style.borderLeftColor = k[4];
  });
  $('totals').innerHTML =
    '<tr><td>Gross CO2</td><td class="text-end">' + fmt(r.grossCO2) + ' kg/day</td></tr>' +
    '<tr><td>Absorbed by greenery</td><td class="text-end">' + fmt(r.absorbedCO2) + ' kg/day</td></tr>' +
    '<tr><td>Solar generation</td><td class="text-end">' + fmt(r.solarKwh) + ' kWh/day</td></tr>' +
    '<tr><td>Energy demand</td><td class="text-end">' + fmt(r.demandKwh) + ' kWh/day</td></tr>' +
    '<tr><td>Electric vehicles</td><td class="text-end">' + fmt(r.evVehicles) + '</td></tr>';
  $('tips').innerHTML = r.tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');

  var data = [r.congestion, r.pollution, r.renewable, Math.min(100, r.greenery / 25 * 100), r.score];
  var cols = [colorFor(r.congestion, false), colorFor(r.pollution, false), colorFor(r.renewable, true),
              colorFor(data[3], true), colorFor(r.score, true)];
  var labels = ['Congestion', 'Pollution', 'Renewable', 'Greenery (vs 25% goal)', 'Score'];
  if (!barChart) {
    barChart = new Chart($('barChart'), {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: data, backgroundColor: cols, borderRadius: 6 }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } },
                 scales: { x: { min: 0, max: 100 } }, animation: { duration: 250 } }
    });
  } else {
    barChart.data.datasets[0].data = data; barChart.data.datasets[0].backgroundColor = cols; barChart.update();
  }
  drawCity(p, r);
}

/* ---------- live city illustration ---------- */
function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
function mix(a, b, t) { return Math.round(a + (b - a) * t); }
function drawCity(p, r) {
  var c = $('sky'), x = c.getContext('2d'), W = c.width, H = c.height, h = r.pollution / 100, rand = rng(42);
  var g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgb(' + mix(110, 150, h) + ',' + mix(180, 140, h) + ',' + mix(215, 120, h) + ')');
  g.addColorStop(1, 'rgb(' + mix(215, 190, h) + ',' + mix(235, 175, h) + ',' + mix(240, 150, h) + ')');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  var ground = 196, n = Math.round(4 + p.buildings / 1000 * 30), bw = W / n, solarN = Math.round(p.solar / 150000 * n);
  for (var i = 0; i < n; i++) {
    var bh = 50 + rand() * 110, bx = i * bw + 3, tone = 40 + Math.round(rand() * 30);
    x.fillStyle = 'rgb(' + tone + ',' + (tone + 30) + ',' + (tone + 36) + ')';
    x.fillRect(bx, ground - bh, bw - 6, bh);
    x.fillStyle = 'rgba(255,235,160,.55)';
    for (var wy = ground - bh + 8; wy < ground - 12; wy += 14)
      for (var wx = bx + 6; wx < bx + bw - 14; wx += 12) if (rand() > .45) x.fillRect(wx, wy, 5, 7);
    if (i < solarN) { x.fillStyle = '#3b7ea1'; x.fillRect(bx, ground - bh - 5, bw - 6, 5); x.fillStyle = '#8fd0ec'; x.fillRect(bx + 3, ground - bh - 4, bw - 12, 2); }
  }
  x.fillStyle = '#35484a'; x.fillRect(0, ground, W, H - ground);
  x.fillStyle = '#e9e3b4'; for (var d = 0; d < W; d += 50) x.fillRect(d, ground + 22, 26, 3);
  var cars = Math.round(p.vehicles / 20000 * 34), evShare = p.ev / 100;
  for (var k = 0; k < cars; k++) {
    var cx = rand() * (W - 24), lane = rand() > .5 ? 8 : 30;
    x.fillStyle = rand() < evShare ? '#5fd0a5' : '#d9824b'; x.fillRect(cx, ground + lane, 22, 9);
    x.fillStyle = '#111'; x.fillRect(cx + 3, ground + lane + 8, 4, 3); x.fillRect(cx + 15, ground + lane + 8, 4, 3);
  }
  var trees = Math.round(p.trees / 100000 * 55 + p.green / 200 * 18);
  for (var t = 0; t < trees; t++) {
    var tx = rand() * W, tr = 6 + rand() * 7;
    x.fillStyle = '#5a4630'; x.fillRect(tx - 1.5, ground - 10, 3, 12);
    x.fillStyle = 'rgb(' + (40 + Math.round(rand() * 30)) + ',' + (120 + Math.round(rand() * 50)) + ',80)';
    x.beginPath(); x.arc(tx, ground - 12, tr, 0, 6.3); x.fill();
  }
  x.fillStyle = 'rgba(150,125,85,' + (h * 0.5).toFixed(2) + ')'; x.fillRect(0, 0, W, H);
}

/* ---------- saved cities ---------- */
function loadList() {
  return api('/api/cities').then(function (list) {
    cities = list; renderList();
    if (!$('page_compare').classList.contains('d-none')) renderCompare();
  });
}
function renderList() {
  if (!cities.length) { $('list').innerHTML = '<div class="text-muted small">No saved cities yet. Set up a layout and choose Save city.</div>'; return; }
  $('list').innerHTML = cities.map(function (c) {
    return '<div class="city-row">' +
      '<div class="nm"><b>' + esc(c.name) + (c._id === currentId ? ' (open)' : '') + '</b><small>Score ' + c.results.score + ' - ' + c.results.status + '</small></div>' +
      '<button class="btn btn-sm btn-line" data-open="' + c._id + '">Open</button>' +
      '<button class="btn btn-sm btn-line" data-del="' + c._id + '" aria-label="Delete ' + esc(c.name) + '">Delete</button></div>';
  }).join('');
}
$('list').onclick = function (e) {
  var o = e.target.getAttribute('data-open'), d = e.target.getAttribute('data-del');
  if (o) {
    var c = cities.filter(function (x) { return x._id === o; })[0];
    currentId = c._id; $('cName').value = c.name; animateTo(c.params); updateEditing(); renderList();
  }
  if (d && confirm('Delete this city?')) {
    api('/api/cities/' + d, 'DELETE').then(function () {
      if (currentId === d) { currentId = null; updateEditing(); }
      toast('City deleted'); return loadList();
    }).catch(function (er) { toast(er.message); });
  }
};
function updateEditing() {
  $('copyBtn').classList.toggle('d-none', !currentId);
  $('saveBtn').textContent = currentId ? 'Update city' : 'Save city';
  $('editing').textContent = currentId ? 'Editing a saved city. Update replaces it.' : '';
}
function save(asNew) {
  var body = { name: $('cName').value.trim(), params: readParams() };
  if (!body.name) { toast('Enter a city name first'); return; }
  var req = (currentId && !asNew) ? api('/api/cities/' + currentId, 'PUT', body) : api('/api/cities', 'POST', body);
  req.then(function (c) { currentId = c._id; updateEditing(); toast(asNew ? 'Copy saved' : 'City saved'); return loadList(); })
     .catch(function (e) { toast(e.message); });
}
$('saveBtn').onclick = function () { save(false); };
$('copyBtn').onclick = function () { save(true); };
$('newBtn').onclick = function () {
  currentId = null; $('cName').value = 'My new city';
  animateTo(PRESETS.balanced); updateEditing(); renderList();
};

/* ---------- pages ---------- */
var PAGES = ['dash', 'compare', 'learn'];
function showPage(p) {
  PAGES.forEach(function (n) { $('page_' + n).classList.toggle('d-none', n !== p); });
  Array.prototype.forEach.call(document.querySelectorAll('.nav-links button'), function (b) {
    b.classList.toggle('on', b.getAttribute('data-page') === p);
  });
  if (p === 'compare') renderCompare();
  if (p === 'dash' && barChart) barChart.resize();
  window.scrollTo(0, 0);
}
Array.prototype.forEach.call(document.querySelectorAll('.nav-links button'), function (b) {
  b.onclick = function () { showPage(b.getAttribute('data-page')); };
});
$('goCompare').onclick = function () { showPage('compare'); };

/* ---------- compare page ---------- */
var cmpSel = [];
function cmpOptions() {
  var p = readParams();
  var cur = { _id: 'current', name: 'Current layout (unsaved)', params: p, results: simulate(p) };
  return [cur].concat(cities);
}
function renderCompare() {
  var opts = cmpOptions(), ids = opts.map(function (o) { return o._id; });
  cmpSel = cmpSel.filter(function (id) { return ids.indexOf(id) > -1; });
  $('cmpList').innerHTML = opts.map(function (c) {
    return '<label class="city-row"><input type="checkbox" class="cmpchk" value="' + c._id + '"' + (cmpSel.indexOf(c._id) > -1 ? ' checked' : '') + '>' +
      '<div class="nm"><b>' + esc(c.name) + '</b><small>Score ' + c.results.score + ' - ' + c.results.status + '</small></div></label>';
  }).join('');
  drawCompare();
}
$('cmpList').onchange = function (e) {
  if (!e.target.classList.contains('cmpchk')) return;
  var id = e.target.value;
  if (e.target.checked) {
    if (cmpSel.length >= 4) { e.target.checked = false; toast('Choose up to four cities'); return; }
    cmpSel.push(id);
  } else { cmpSel = cmpSel.filter(function (x) { return x !== id; }); }
  drawCompare();
};
function drawCompare() {
  var opts = cmpOptions();
  var sel = cmpSel.map(function (id) { return opts.filter(function (o) { return o._id === id; })[0]; });
  if (cmpChart) { cmpChart.destroy(); cmpChart = null; }
  $('cmpEmpty').classList.toggle('d-none', sel.length >= 2);
  $('cmpBody').classList.toggle('d-none', sel.length < 2);
  if (sel.length < 2) return;

  var sorted = sel.slice().sort(function (a, b) { return b.results.score - a.results.score; });
  var top = sorted[0], second = sorted[1], gap = top.results.score - second.results.score;
  $('cmpBanner').innerHTML = '<h5 class="mb-1">' + esc(top.name) + ' scores highest</h5>' +
    '<div class="text-muted">' + top.results.score + ' out of 100 (' + top.results.status + ')' +
    (gap > 0 ? ', ' + gap + ' points ahead of ' + esc(second.name) + '.' : ', tied with ' + esc(second.name) + '.') + '</div>';

  var palette = ['#2f7d6b', '#d9822b', '#3b7ea1', '#c2453d'];
  var labels = ['Traffic flow', 'Clean air', 'Renewable', 'Greenery', 'Score'];
  cmpChart = new Chart($('cmpChart'), {
    type: 'radar',
    data: { labels: labels, datasets: sel.map(function (c, i) {
      var r = c.results;
      return { label: c.name, data: [100 - r.congestion, 100 - r.pollution, r.renewable, Math.min(100, r.greenery / 25 * 100), r.score],
               borderColor: palette[i], backgroundColor: palette[i] + '22', pointBackgroundColor: palette[i] };
    }) },
    options: { scales: { r: { min: 0, max: 100, ticks: { stepSize: 25 } } } }
  });

  var rows = [
    ['Score', 'score', true], ['Congestion (%)', 'congestion', false], ['Pollution index', 'pollution', false],
    ['Renewable (%)', 'renewable', true], ['Greenery (%)', 'greenery', true], ['Net CO2 (kg/day)', 'netCO2', false]
  ];
  var prm = [['Vehicles', 'vehicles'], ['Electric (%)', 'ev'], ['Transit (%)', 'transit'], ['Buildings', 'buildings'],
             ['Trees', 'trees'], ['Solar panels', 'solar'], ['Green space (ha)', 'green']];
  var t = '<thead><tr><th></th>' + sel.map(function (c) { return '<th>' + esc(c.name) + '</th>'; }).join('') + '</tr></thead><tbody>';
  rows.forEach(function (m) {
    var vals = sel.map(function (c) { return c.results[m[1]]; });
    var best = m[2] ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
    var allSame = vals.every(function (v) { return v === vals[0]; });
    t += '<tr><td>' + m[0] + '</td>' + vals.map(function (v) {
      return '<td class="' + (!allSame && v === best ? 'best' : '') + '">' + fmt(v) + '</td>';
    }).join('') + '</tr>';
  });
  t += '<tr><th colspan="' + (sel.length + 1) + '" class="pt-3">Layout settings</th></tr>';
  prm.forEach(function (m) {
    t += '<tr><td>' + m[0] + '</td>' + sel.map(function (c) { return '<td>' + fmt(c.params[m[1]]) + '</td>'; }).join('') + '</tr>';
  });
  $('cmpTable').innerHTML = t + '</tbody>';
}

/* ---------- start ---------- */
function enter() {
  $('authView').classList.add('d-none'); $('appView').classList.remove('d-none');
  $('who').textContent = localStorage.getItem('ecosim_user') || '';
  if (!$('controls').children.length) buildControls();
  updateEditing(); showPage('dash');
  setParams({ vehicles: 0, ev: 0, transit: 0, buildings: 0, trees: 0, solar: 0, green: 0 });
  render(); animateTo(currentId ? readParams() : PRESETS.balanced);
  loadList().catch(function () {});
}
if (token) enter(); else startAuthArt();
</script>
</body>
</html>`;