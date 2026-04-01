import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════════
// ALGORITHM
// ═══════════════════════════════════════════════════════════════════

function haversineKm(a, b) {
  const R = 6371.0;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function travelMin(a, b, cfg) {
  return ((haversineKm(a, b) * cfg.detourFactor) / cfg.avgSpeedKmh) * 60;
}

function calcTripTimes(trip, pizzeria, cfg) {
  const ds = trip.deliveries;
  if (!ds.length) return trip;
  const relArrivals = [];
  let pos = pizzeria, t = 0;
  for (const d of ds) {
    t += travelMin(pos, d, cfg);
    relArrivals.push(t);
    t += cfg.stopTimeMin;
    pos = d;
  }
  const latestDeps = ds.map((d, i) => d.slot - relArrivals[i]);
  trip.departureTime = Math.min(...latestDeps);
  // Departure floor: rider cannot leave before slot - earlyToleranceMin (pizzas not ready)
  const departureFloor = ds[0].slot - cfg.earlyToleranceMin;
  trip.departureTime = Math.max(trip.departureTime, departureFloor);
  trip.totalTime = relArrivals[relArrivals.length - 1] + cfg.stopTimeMin;
  const returnTravel = travelMin(ds[ds.length - 1], pizzeria, cfg);
  trip.returnTime = trip.totalTime + returnTravel;
  trip.arrivalTimes = relArrivals.map((r) => trip.departureTime + r);
  trip.totalPizzas = ds.reduce((s, d) => s + d.numPizzas, 0);
  return trip;
}

function lateToleranceForDelivery(delivery, pizzeria, cfg) {
  const distKm = haversineKm(pizzeria, delivery) * cfg.detourFactor;
  const extra = cfg.distToleranceFactor * distKm;
  return Math.min(cfg.lateToleranceMin + extra, cfg.tMaxMin);
}

function isTripValid(trip, pizzeria, cfg) {
  if (!trip.deliveries.length) return true;
  if (trip.totalPizzas > cfg.pizzeCapacity) return false;
  if (trip.deliveries.length > cfg.maxDeliveriesPerTrip) return false;
  if (trip.departureTime < trip.deliveries[0].slot - cfg.earlyToleranceMin) return false;

  // ─── TOLLERANZA GEOMETRICA CONTINUA ───
  // Più spatialElasticity è alto, più è permissivo con giri che hanno consegne vicine
  const ELASTICITA = cfg.spatialElasticity;
  let maxDist = 0, farthestDel = null;
  for (const d of trip.deliveries) {
    const dist = haversineKm(pizzeria, d);
    if (dist > maxDist) { maxDist = dist; farthestDel = d; }
  }
  const deviazioneMassimaPermessa = ELASTICITA / Math.max(maxDist, 0.1);
  if (trip.deliveries.length > 1) {
    for (const d of trip.deliveries) {
      if (d === farthestDel) continue;
      const deviazioneReale = haversineKm(pizzeria, d) + haversineKm(d, farthestDel) - maxDist;
      if (deviazioneReale > deviazioneMassimaPermessa) return false;
    }
  }
  // ──────────────────────────────────────

  let pos = pizzeria, t = trip.departureTime;
  for (const d of trip.deliveries) {
    t += travelMin(pos, d, cfg);
    if (t > d.slot + lateToleranceForDelivery(d, pizzeria, cfg)) return false;
    t += cfg.stopTimeMin;
    pos = d;
  }
  return true;
}

function tripReturnTime(trip) {
  return trip.departureTime + trip.returnTime;
}

function hasTimelineConflict(riderTrips, candidate, originalIdx) {
  const cStart = candidate.departureTime;
  const cEnd = tripReturnTime(candidate);
  for (let i = 0; i < riderTrips.length; i++) {
    if (i === originalIdx) continue;
    const g = riderTrips[i];
    if (cStart < tripReturnTime(g) && g.departureTime < cEnd) return true;
  }
  return false;
}

function deepCloneTrip(trip) {
  return {
    ...trip,
    deliveries: trip.deliveries.map((d) => ({ ...d })),
    arrivalTimes: trip.arrivalTimes ? [...trip.arrivalTimes] : [],
  };
}

function cheapestInsertion(trip, newDel, pizzeria, cfg) {
  const candidates = [];
  for (let i = 0; i <= trip.deliveries.length; i++) {
    const g = deepCloneTrip(trip);
    g.deliveries.splice(i, 0, { ...newDel });
    calcTripTimes(g, pizzeria, cfg);
    if (isTripValid(g, pizzeria, cfg)) candidates.push(g);
  }
  candidates.sort((a, b) => a.totalTime - b.totalTime);
  return candidates;
}

function tripDeviation(trip) {
  if (!trip.arrivalTimes || !trip.deliveries.length) return 0;
  let dev = 0;
  for (let i = 0; i < trip.deliveries.length; i++) {
    dev += Math.abs(trip.arrivalTimes[i] - trip.deliveries[i].slot);
  }
  return dev;
}

// ── Global re-optimization helpers ──

function extractAllDeliveries(riders) {
  const deliveries = [];
  for (const rider of riders)
    for (const trip of rider.trips)
      for (const d of trip.deliveries)
        deliveries.push({ ...d });
  return deliveries;
}

function riderHasConflicts(trips) {
  for (let i = 0; i < trips.length; i++)
    for (let j = i + 1; j < trips.length; j++)
      if (trips[i].departureTime < tripReturnTime(trips[j]) &&
        trips[j].departureTime < tripReturnTime(trips[i]))
        return true;
  return false;
}

function totalCost(riders, cfg) {
  let total = 0;
  for (const r of riders)
    for (const t of r.trips) {
      if (cfg.costMethod === "savings") {
        total += t.returnTime;
      } else {
        // perConsegna (V1)
        total += t.returnTime / t.deliveries.length;
      }
      total += cfg.deviationWeight * tripDeviation(t);
    }
  return total;
}

// Build all routes from scratch with smart seed ordering + cheapest insertion
function rebuildAllRoutes(allDeliveries, numRiders, pizzeria, cfg) {
  // Seed ordering: slot ascending, then farthest from pizzeria first
  const sorted = [...allDeliveries].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    return haversineKm(pizzeria, b) - haversineKm(pizzeria, a);
  });

  const riders = Array.from({ length: numRiders }, (_, i) => ({ id: i, trips: [] }));

  for (const del of sorted) {
    let bestOption = null, bestCost = Infinity;

    // Costo standalone: giro con solo questa consegna (serve per V3-savings)
    const standaloneTrip = { deliveries: [{ ...del }], totalPizzas: del.numPizzas };
    calcTripTimes(standaloneTrip, pizzeria, cfg);
    const standaloneSec = standaloneTrip.returnTime * 60;

    for (let ri = 0; ri < riders.length; ri++) {
      const rider = riders[ri];

      // Option A: insert into existing trip
      for (let ti = 0; ti < rider.trips.length; ti++) {
        const trip = rider.trips[ti];
        if (trip.totalPizzas + del.numPizzas > cfg.pizzeCapacity) continue;
        if (trip.deliveries.length >= cfg.maxDeliveriesPerTrip) continue;
        if (trip.deliveries.length > 0 && trip.deliveries[0].slot !== del.slot) continue;

        const candidates = cheapestInsertion(trip, del, pizzeria, cfg);
        for (const cand of candidates) {
          if (hasTimelineConflict(rider.trips, cand, ti)) continue;
          if (cfg.availabilityConstraint) {
            const origTrip = rider.trips[ti];
            rider.trips[ti] = cand;
            const availOk = countUnavailableRidersForSlot(riders, del.slot, pizzeria, cfg) < cfg.numRiders;
            rider.trips[ti] = origTrip;
            if (!availOk) continue;
          }

          let cost;
          if (cfg.costMethod === "savings") {
            const delta = (cand.returnTime - trip.returnTime) * 60;
            const savings = standaloneSec - delta;
            cost = delta * (standaloneSec / Math.max(savings, 60));
          } else {
            // perConsegna (V1)
            cost = (cand.returnTime * 60) / cand.deliveries.length;
          }
          cost += cfg.deviationWeight * tripDeviation(cand);

          if (cost < bestCost) {
            bestCost = cost;
            bestOption = { riderId: ri, tripIdx: ti, trip: cand };
          }
          break;
        }
      }

      // Option B: new trip (small load-balancing tiebreaker)
      const newTrip = { deliveries: [{ ...del }], totalPizzas: del.numPizzas };
      calcTripTimes(newTrip, pizzeria, cfg);
      if (isTripValid(newTrip, pizzeria, cfg) && !hasTimelineConflict(rider.trips, newTrip, -1)) {
        if (cfg.availabilityConstraint) {
          rider.trips.push(newTrip);
          const availOk = countUnavailableRidersForSlot(riders, del.slot, pizzeria, cfg) < cfg.numRiders;
          rider.trips.pop();
          if (!availOk) continue;
        }

        let cost;
        if (cfg.costMethod === "savings") {
          cost = standaloneSec + rider.trips.length * 0.001;
        } else {
          // perConsegna (V1): giro da 1 consegna, costo = returnTime
          cost = newTrip.returnTime * 60 + rider.trips.length * 0.001;
        }
        cost += cfg.deviationWeight * tripDeviation(newTrip);

        if (cost < bestCost) {
          bestCost = cost;
          bestOption = { riderId: ri, tripIdx: -1, trip: newTrip };
        }
      }
    }

    if (bestOption) {
      const rider = riders[bestOption.riderId];
      if (bestOption.tripIdx >= 0) {
        rider.trips[bestOption.tripIdx] = bestOption.trip;
      } else {
        rider.trips.push(bestOption.trip);
      }
    }
  }

  return riders;
}

// 2-opt: improve delivery order within a single trip
function twoOpt(trip, pizzeria, cfg) {
  const n = trip.deliveries.length;
  if (n < 3) return trip;
  let best = deepCloneTrip(trip);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 2; j < n; j++) {
        const cand = deepCloneTrip(best);
        const rev = cand.deliveries.slice(i + 1, j + 1).reverse();
        cand.deliveries.splice(i + 1, j - i, ...rev);
        calcTripTimes(cand, pizzeria, cfg);
        if (isTripValid(cand, pizzeria, cfg) && cand.returnTime < best.returnTime) {
          best = cand;
          improved = true;
        }
      }
    }
  }
  return best;
}

function twoOptAll(riders, pizzeria, cfg) {
  for (const rider of riders)
    for (let ti = 0; ti < rider.trips.length; ti++)
      rider.trips[ti] = twoOpt(rider.trips[ti], pizzeria, cfg);
}

// Or-opt: try moving each delivery to a better trip
function orOpt(riders, pizzeria, cfg) {
  let improved = true;
  while (improved) {
    improved = false;
    for (let sri = 0; sri < riders.length && !improved; sri++) {
      for (let sti = 0; sti < riders[sri].trips.length && !improved; sti++) {
        const srcTrip = riders[sri].trips[sti];
        for (let di = 0; di < srcTrip.deliveries.length && !improved; di++) {
          const delivery = srcTrip.deliveries[di];

          for (let dri = 0; dri < riders.length && !improved; dri++) {
            for (let dti = 0; dti < riders[dri].trips.length && !improved; dti++) {
              if (sri === dri && sti === dti) continue;
              const dstTrip = riders[dri].trips[dti];
              if (dstTrip.deliveries.length > 0 && dstTrip.deliveries[0].slot !== delivery.slot) continue;
              if (dstTrip.deliveries.length >= cfg.maxDeliveriesPerTrip) continue;
              if (dstTrip.totalPizzas + delivery.numPizzas > cfg.pizzeCapacity) continue;

              // Build new source without this delivery
              const newSrc = deepCloneTrip(srcTrip);
              newSrc.deliveries.splice(di, 1);
              newSrc.totalPizzas = newSrc.deliveries.reduce((s, d) => s + d.numPizzas, 0);
              if (newSrc.deliveries.length > 0) calcTripTimes(newSrc, pizzeria, cfg);

              // Try cheapest insertion into destination
              const dstCandidates = cheapestInsertion(dstTrip, delivery, pizzeria, cfg);
              if (!dstCandidates.length) continue;
              const newDst = dstCandidates[0];

              // Check improvement
              let oldTotal, newTotal;
              if (cfg.costMethod === "savings") {
                oldTotal = srcTrip.returnTime + dstTrip.returnTime;
                newTotal = (newSrc.deliveries.length > 0 ? newSrc.returnTime : 0) + newDst.returnTime;
              } else {
                // perConsegna (V1)
                oldTotal = srcTrip.returnTime / srcTrip.deliveries.length
                  + dstTrip.returnTime / dstTrip.deliveries.length;
                newTotal = (newSrc.deliveries.length > 0 ? newSrc.returnTime / newSrc.deliveries.length : 0)
                  + newDst.returnTime / newDst.deliveries.length;
              }
              oldTotal += cfg.deviationWeight * (tripDeviation(srcTrip) + tripDeviation(dstTrip));
              newTotal += cfg.deviationWeight * (
                (newSrc.deliveries.length > 0 ? tripDeviation(newSrc) : 0) + tripDeviation(newDst)
              );
              if (newTotal >= oldTotal - 0.01) continue;

              // Validate timeline conflicts
              let valid;
              if (sri === dri) {
                const tempTrips = riders[sri].trips.map((t, i) =>
                  i === sti ? newSrc : i === dti ? newDst : t
                ).filter(t => t.deliveries.length > 0);
                valid = !riderHasConflicts(tempTrips);
              } else {
                const srcTrips = riders[sri].trips.map((t, i) => i === sti ? newSrc : t).filter(t => t.deliveries.length > 0);
                const dstTrips = riders[dri].trips.map((t, i) => i === dti ? newDst : t);
                valid = !riderHasConflicts(srcTrips) && !riderHasConflicts(dstTrips);
              }
              if (!valid) continue;

              // Apply move
              riders[sri].trips[sti] = newSrc;
              riders[dri].trips[dti] = newDst;
              for (const r of riders) r.trips = r.trips.filter(t => t.deliveries.length > 0);
              improved = true;
            }
          }
        }
      }
    }
  }
}

// ── Rider availability constraint ──

function countUnavailableRidersForSlot(riders, slotTime, pizzeria, cfg) {
  let count = 0;
  for (const rider of riders) {
    for (const trip of rider.trips) {
      if (trip.deliveries.length && trip.deliveries[0].slot === slotTime) {
        const maxTravelTime = Math.max(...trip.deliveries.map(d => travelMin(pizzeria, d, cfg)));
        if (maxTravelTime > cfg.earlyToleranceMin) { count++; break; }
      }
    }
  }
  return count;
}

function slotAvailabilityValid(riders, pizzeria, cfg) {
  const slotTimes = new Set();
  for (const r of riders) for (const t of r.trips) for (const d of t.deliveries) slotTimes.add(d.slot);
  const maxUnavailable = cfg.numRiders - 1;
  for (const slotTime of slotTimes) {
    if (countUnavailableRidersForSlot(riders, slotTime, pizzeria, cfg) > maxUnavailable) return false;
  }
  return true;
}

// Main: calculate available slots using global re-optimization
function calcAvailableSlots(slots, newCoord, numPizzas, orderId, riders, pizzeria, cfg) {
  if (numPizzas > cfg.pizzeCapacity) return [];
  const existingDeliveries = extractAllDeliveries(riders);
  const currentCost = totalCost(riders, cfg);
  const results = [];

  for (const slot of slots) {
    const newDel = { id: orderId, lat: newCoord.lat, lng: newCoord.lng, numPizzas, slot };
    const allDeliveries = [...existingDeliveries, newDel];

    const newRiders = rebuildAllRoutes(allDeliveries, riders.length, pizzeria, cfg);
    twoOptAll(newRiders, pizzeria, cfg);
    orOpt(newRiders, pizzeria, cfg);

    // Verify ALL deliveries (existing + new) were assigned
    const assignedIds = new Set();
    for (const r of newRiders) for (const t of r.trips) for (const d of t.deliveries) assignedIds.add(d.id);
    if (assignedIds.size !== allDeliveries.length) continue;

    if (cfg.availabilityConstraint && !slotAvailabilityValid(newRiders, pizzeria, cfg)) continue;

    const cost = totalCost(newRiders, cfg) - currentCost;
    results.push({ slot, newRiders, cost, orderId });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════
// TRAINING MODE HELPERS
// ═══════════════════════════════════════════════════════════════════

function generateTrainingScenario(n, pizzeria) {
  const slotGrid = [];
  for (let t = 18 * 60; t <= 21 * 60; t += 15) slotGrid.push(t);
  const deliveries = [];
  for (let i = 0; i < n; i++) {
    deliveries.push({
      id: `train-${i}`,
      lat: pizzeria.lat + (Math.random() - 0.5) * 0.045,
      lng: pizzeria.lng + (Math.random() - 0.5) * 0.06,
      numPizzas: Math.ceil(Math.random() * 4),
      slot: slotGrid[Math.floor(Math.random() * slotGrid.length)],
    });
  }
  return deliveries;
}

function metricColor(value, greenMax, yellowMax) {
  if (value <= greenMax) return "#22c55e";
  if (value <= yellowMax) return "#f59e0b";
  return "#ef4444";
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════════════════════════

const RIDER_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899"];
const PIZZERIA_DEFAULT = { lat: 45.428978, lng: 12.077287 };

const PHASE2_PARAMS = [
  ["Penalità nuovo giro",   "newTripPenalty",       1.0, 3.0,  0.1],
  ["Max cons./giro",        "maxDeliveriesPerTrip", 1,   10,   1  ],
  ["Tolleranza distanza",   "distToleranceFactor",  0,   3.0,  0.1],
  ["Durata slot (min)",     "slotDurationMin",      5,   30,   5  ],
  ["Peso deviazione",       "deviationWeight",      0,   5.0,  0.1],
  ["Elasticità spaziale",   "spatialElasticity",    0.5, 30.0, 0.5],
];

const DEFAULT_CFG = {
  numRiders: 2, pizzeCapacity: 12, tMaxMin: 30, earlyToleranceMin: 10, lateToleranceMin: 10,
  detourFactor: 1.7, avgSpeedKmh: 25, stopTimeMin: 4, newTripPenalty: 1.5, maxDeliveriesPerTrip: 4,
  distToleranceFactor: 1.0, slotDurationMin: 15,
  costMethod: "perConsegna", // "perConsegna" (V1) oppure "savings" (V3)
  deviationWeight: 1.0, // peso penalità deviazione |arrivo - slot|
  spatialElasticity: 6.0, // tolleranza geometrica: più alto = più permissivo
  availabilityConstraint: true, // vincolo: almeno 1 fattorino libero per slot successivo
};

const timeStr = (min) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const genSlots = (startH, startM, endH, endM, interval) => {
  const slots = [];
  let t = startH * 60 + startM;
  const end = endH * 60 + endM;
  while (t <= end) { slots.push(t); t += interval; }
  return slots;
};

let _idCounter = 0;
const nextId = () => `ord-${++_idCounter}`;

const PRESET_ORDERS = [
  { lat: 45.4180, lng: 11.8810, numPizzas: 3, slot: 18 * 60 + 30, label: "Arcella" },
  { lat: 45.4100, lng: 11.8950, numPizzas: 2, slot: 18 * 60 + 30, label: "Stanga" },
  { lat: 45.3950, lng: 11.9050, numPizzas: 4, slot: 19 * 60, label: "Forcellini" },
  { lat: 45.4050, lng: 11.8600, numPizzas: 2, slot: 19 * 60, label: "Mandria" },
  { lat: 45.4150, lng: 11.8650, numPizzas: 3, slot: 19 * 60, label: "Sacra Famiglia" },
];

// ═══════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════

export default function App() {
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [pizzeria] = useState(PIZZERIA_DEFAULT);
  const [slots] = useState(() => genSlots(18, 0, 21, 0, 15));
  const [riders, setRiders] = useState(() =>
    Array.from({ length: DEFAULT_CFG.numRiders }, (_, i) => ({ id: i, trips: [] }))
  );
  const [mapReady, setMapReady] = useState(false);
  const [newOrderPos, setNewOrderPos] = useState(null);
  const [newOrderPizzas, setNewOrderPizzas] = useState(2);
  const [availableSlots, setAvailableSlots] = useState(null);
  const [previewSlot, setPreviewSlot] = useState(null);
  const [selectedTripKey, setSelectedTripKey] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [mode, setMode] = useState("view"); // view | placing | selecting

  // ── Training Mode State ──
  const [trainingMode, setTrainingMode] = useState(false);
  const [trainingN, setTrainingN] = useState(8);
  const [trainingDeliveries, setTrainingDeliveries] = useState([]);
  const [trainingRiders, setTrainingRiders] = useState([]);
  const [trainingCfg, setTrainingCfg] = useState({
    newTripPenalty: DEFAULT_CFG.newTripPenalty,
    maxDeliveriesPerTrip: DEFAULT_CFG.maxDeliveriesPerTrip,
    distToleranceFactor: DEFAULT_CFG.distToleranceFactor,
    slotDurationMin: DEFAULT_CFG.slotDurationMin,
    deviationWeight: DEFAULT_CFG.deviationWeight,
    spatialElasticity: DEFAULT_CFG.spatialElasticity,
  });
  const trainingRecomputeTimer = useRef(null);
  const [trainingPlacing, setTrainingPlacing] = useState(false);
  const [trainingNewPizzas, setTrainingNewPizzas] = useState(2);
  const [trainingNewSlot, setTrainingNewSlot] = useState(18 * 60);

  const mapRef = useRef(null);
  const mapInst = useRef(null);
  const layersRef = useRef({ markers: null, routes: null, preview: null, newMarker: null, pizzeriaMarker: null });

  // ── Leaflet loading ──
  useEffect(() => {
    if (window.L) { setMapReady(true); return; }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
    script.onload = () => setMapReady(true);
    document.head.appendChild(script);
  }, []);

  // ── Map init ──
  useEffect(() => {
    if (!mapReady || !mapRef.current || mapInst.current) return;
    const L = window.L;
    const map = L.map(mapRef.current, { zoomControl: false }).setView([pizzeria.lat, pizzeria.lng], 14);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);
    layersRef.current.markers = L.layerGroup().addTo(map);
    layersRef.current.routes = L.layerGroup().addTo(map);
    layersRef.current.preview = L.layerGroup().addTo(map);

    const pizzaIcon = L.divIcon({
      html: `<div style="background:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.4);">🍕</div>`,
      iconSize: [28, 28], iconAnchor: [14, 14], className: "",
    });
    layersRef.current.pizzeriaMarker = L.marker([pizzeria.lat, pizzeria.lng], { icon: pizzaIcon })
      .bindTooltip("Pizzeria", {
        permanent: true, direction: "top", offset: [0, -16],
        className: "pizzeria-tooltip"
      })
      .addTo(map);

    map.on("click", (e) => {
      window._mapClick && window._mapClick(e.latlng);
    });
    mapInst.current = map;

    setTimeout(() => map.invalidateSize(), 200);
  }, [mapReady, pizzeria]);

  // ── Map click handler ──
  useEffect(() => {
    window._mapClick = (latlng) => {
      if (trainingMode && trainingPlacing) {
        setTrainingDeliveries((prev) => [
          ...prev,
          {
            id: `train-m-${Date.now()}`,
            lat: latlng.lat,
            lng: latlng.lng,
            numPizzas: trainingNewPizzas,
            slot: trainingNewSlot,
          },
        ]);
      } else if (mode === "placing") {
        setNewOrderPos({ lat: latlng.lat, lng: latlng.lng });
      }
    };
    return () => { window._mapClick = null; };
  }, [mode, trainingMode, trainingPlacing, trainingNewPizzas, trainingNewSlot]);

  // ── Draw new order marker ──
  useEffect(() => {
    if (!mapReady || !mapInst.current) return;
    const L = window.L;
    const pg = layersRef.current;
    if (pg.newMarker) { mapInst.current.removeLayer(pg.newMarker); pg.newMarker = null; }
    if (newOrderPos) {
      const icon = L.divIcon({
        html: `<div style="background:#fbbf24;border:3px solid #fff;border-radius:50%;width:20px;height:20px;box-shadow:0 0 12px #fbbf24;"></div>`,
        iconSize: [20, 20], iconAnchor: [10, 10], className: "",
      });
      pg.newMarker = L.marker([newOrderPos.lat, newOrderPos.lng], { icon }).addTo(mapInst.current);
    }
  }, [newOrderPos, mapReady]);

  // ── Draw riders trips on map ──
  const drawMap = useCallback(() => {
    if (trainingMode) return;
    if (!mapReady || !mapInst.current) return;
    const L = window.L;
    const { markers, routes, preview } = layersRef.current;
    markers.clearLayers();
    routes.clearLayers();
    preview.clearLayers();

    riders.forEach((rider, ri) => {
      const color = RIDER_COLORS[ri % RIDER_COLORS.length];
      rider.trips.forEach((trip, ti) => {
        const tripKey = `${ri}-${ti}`;
        const isSelected = selectedTripKey === tripKey;
        const opacity = previewSlot ? 0.15 : (selectedTripKey ? (isSelected ? 1 : 0.25) : 0.8);

        // Route polyline
        const points = [
          [pizzeria.lat, pizzeria.lng],
          ...trip.deliveries.map((d) => [d.lat, d.lng]),
          [pizzeria.lat, pizzeria.lng],
        ];
        const poly = L.polyline(points, {
          color, weight: isSelected ? 5 : 3, opacity,
          dashArray: isSelected ? null : "8 4",
        }).addTo(routes);
        poly.on("click", () => setSelectedTripKey(isSelected ? null : tripKey));

        // Delivery markers
        trip.deliveries.forEach((d, di) => {
          const icon = L.divIcon({
            html: `<div style="
              background:${color};border:2px solid #fff;border-radius:50%;
              width:24px;height:24px;display:flex;align-items:center;justify-content:center;
              font-size:11px;font-weight:700;color:#fff;opacity:${opacity};
              box-shadow:0 2px 6px ${color}80;
            ">${di + 1}</div>`,
            iconSize: [24, 24], iconAnchor: [12, 12], className: "",
          });
          const arrTime = trip.arrivalTimes ? timeStr(trip.arrivalTimes[di]) : "?";
          L.marker([d.lat, d.lng], { icon })
            .bindTooltip(`${d.id} · ${d.numPizzas}🍕 · arrivo ${arrTime}`, { direction: "top", offset: [0, -14] })
            .addTo(markers);
        });
      });
    });

    // Preview: draw all routes from the re-optimized assignment
    if (previewSlot && previewSlot.newRiders) {
      previewSlot.newRiders.forEach((rider, ri) => {
        const color = RIDER_COLORS[ri % RIDER_COLORS.length];
        rider.trips.forEach((trip) => {
          const pts = [
            [pizzeria.lat, pizzeria.lng],
            ...trip.deliveries.map((d) => [d.lat, d.lng]),
            [pizzeria.lat, pizzeria.lng],
          ];
          L.polyline(pts, { color, weight: 4, opacity: 0.9, dashArray: "6 6" }).addTo(preview);
          trip.deliveries.forEach((d, di) => {
            const icon = L.divIcon({
              html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;box-shadow:0 0 8px ${color}80;">${di + 1}</div>`,
              iconSize: [20, 20], iconAnchor: [10, 10], className: "",
            });
            const arrTime = trip.arrivalTimes ? timeStr(trip.arrivalTimes[di]) : "?";
            L.marker([d.lat, d.lng], { icon })
              .bindTooltip(`${d.id} · ${d.numPizzas}p · arrivo ${arrTime}`, { direction: "top", offset: [0, -12] })
              .addTo(preview);
          });
        });
      });
    }
  }, [riders, pizzeria, selectedTripKey, previewSlot, mapReady, trainingMode]);

  // ── Draw training map ──
  const drawTrainingMap = useCallback((tRiders) => {
    if (!mapReady || !mapInst.current) return;
    const L = window.L;
    const { markers, routes, preview } = layersRef.current;
    markers.clearLayers();
    routes.clearLayers();
    preview.clearLayers();
    tRiders.forEach((rider, ri) => {
      const color = RIDER_COLORS[ri % RIDER_COLORS.length];
      rider.trips.forEach((trip) => {
        const points = [
          [pizzeria.lat, pizzeria.lng],
          ...trip.deliveries.map((d) => [d.lat, d.lng]),
          [pizzeria.lat, pizzeria.lng],
        ];
        L.polyline(points, { color, weight: 3, opacity: 0.85 }).addTo(routes);
        trip.deliveries.forEach((d, di) => {
          const arrTime = trip.arrivalTimes ? trip.arrivalTimes[di] : d.slot;
          const devMin = Math.abs(arrTime - d.slot);
          const devColor = metricColor(devMin, 3, 8);
          const icon = L.divIcon({
            html: `<div style="background:${color};border:2px solid #fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;box-shadow:0 0 0 3px ${devColor},0 2px 8px rgba(0,0,0,.4);">${di + 1}</div>`,
            iconSize: [26, 26], iconAnchor: [13, 13], className: "",
          });
          L.marker([d.lat, d.lng], { icon })
            .bindTooltip(
              `${d.id} · ${d.numPizzas}🍕 · slot ${timeStr(d.slot)} · arr ${timeStr(arrTime)} · dev ${devMin.toFixed(1)}min`,
              { direction: "top", offset: [0, -16] }
            )
            .addTo(markers);
        });
      });
    });
  }, [mapReady, pizzeria]);

  // ── Training: optimization callbacks (must be before useEffects that reference them) ──
  const runTrainingOptimization = useCallback((deliveries, tCfg) => {
    const fullCfg = { ...cfg, ...tCfg, availabilityConstraint: false };
    const newRiders = rebuildAllRoutes(deliveries, cfg.numRiders, pizzeria, fullCfg);
    twoOptAll(newRiders, pizzeria, fullCfg);
    orOpt(newRiders, pizzeria, fullCfg);
    setTrainingRiders(newRiders);
  }, [cfg, pizzeria]);

  const generateNewScenario = useCallback(() => {
    setTrainingPlacing(false);
    const deliveries = generateTrainingScenario(trainingN, pizzeria);
    const fullCfg = { ...cfg, ...trainingCfg, availabilityConstraint: false };
    const newRiders = rebuildAllRoutes(deliveries, cfg.numRiders, pizzeria, fullCfg);
    twoOptAll(newRiders, pizzeria, fullCfg);
    orOpt(newRiders, pizzeria, fullCfg);
    setTrainingDeliveries(deliveries);
    setTrainingRiders(newRiders);
  }, [trainingN, pizzeria, cfg, trainingCfg]);

  const clearTrainingDeliveries = useCallback(() => {
    setTrainingDeliveries([]);
    setTrainingRiders([]);
    setTrainingPlacing(false);
  }, []);

  useEffect(() => { drawMap(); }, [drawMap]);

  // ── Training: recompute on trainingCfg change (debounced 200ms) ──
  useEffect(() => {
    if (!trainingMode || !trainingDeliveries.length) return;
    clearTimeout(trainingRecomputeTimer.current);
    trainingRecomputeTimer.current = setTimeout(() => {
      runTrainingOptimization(trainingDeliveries, trainingCfg);
    }, 200);
    return () => clearTimeout(trainingRecomputeTimer.current);
  }, [trainingCfg, trainingMode, trainingDeliveries, runTrainingOptimization]);

  // ── Training: redraw map on trainingRiders change ──
  useEffect(() => {
    if (!trainingMode) return;
    drawTrainingMap(trainingRiders);
  }, [trainingMode, trainingRiders, drawTrainingMap]);

  // ── Training: enter/exit mode ──
  useEffect(() => {
    if (trainingMode && trainingDeliveries.length === 0) generateNewScenario();
    if (!trainingMode) drawMap();
    if (mapInst.current) setTimeout(() => mapInst.current.invalidateSize(), 150);
  }, [trainingMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ──
  const loadPreset = () => {
    _idCounter = 0;
    const deliveries = PRESET_ORDERS.map((po) => ({
      id: nextId(), lat: po.lat, lng: po.lng, numPizzas: po.numPizzas, slot: po.slot,
    }));
    const newRiders = rebuildAllRoutes(deliveries, cfg.numRiders, pizzeria, cfg);
    twoOptAll(newRiders, pizzeria, cfg);
    orOpt(newRiders, pizzeria, cfg);
    setRiders(newRiders);
    setAvailableSlots(null);
    setPreviewSlot(null);
    setSelectedTripKey(null);
    setMode("view");
    setNewOrderPos(null);
  };

  const startNewOrder = () => {
    setMode("placing");
    setAvailableSlots(null);
    setPreviewSlot(null);
    setSelectedTripKey(null);
  };

  const findSlots = () => {
    if (!newOrderPos) return;
    const id = nextId();
    const res = calcAvailableSlots(slots, newOrderPos, newOrderPizzas, id, riders, pizzeria, cfg);
    setAvailableSlots(res);
    setMode("selecting");
  };

  const confirmSlot = (slotResult) => {
    setRiders(slotResult.newRiders);
    setAvailableSlots(null);
    setPreviewSlot(null);
    setNewOrderPos(null);
    setMode("view");
  };

  const cancelOrder = () => {
    setMode("view");
    setNewOrderPos(null);
    setAvailableSlots(null);
    setPreviewSlot(null);
  };

  const resetAll = () => {
    _idCounter = 0;
    setRiders(Array.from({ length: cfg.numRiders }, (_, i) => ({ id: i, trips: [] })));
    setAvailableSlots(null);
    setPreviewSlot(null);
    setSelectedTripKey(null);
    setNewOrderPos(null);
    setMode("view");
  };

  // ── Timeline data ──
  const timeRange = useMemo(() => {
    let min = slots[0], max = slots[slots.length - 1];
    riders.forEach((r) => r.trips.forEach((t) => {
      if (t.departureTime < min) min = t.departureTime;
      const ret = tripReturnTime(t);
      if (ret > max) max = ret;
    }));
    return { min: min - 10, max: max + 10 };
  }, [riders, slots]);

  const trainingTimeRange = useMemo(() => {
    let min = slots[0], max = slots[slots.length - 1];
    trainingRiders.forEach((r) => r.trips.forEach((t) => {
      if (t.departureTime < min) min = t.departureTime;
      const ret = tripReturnTime(t);
      if (ret > max) max = ret;
    }));
    return { min: min - 10, max: max + 10 };
  }, [trainingRiders, slots]);

  const trainingMetrics = useMemo(() => {
    if (!trainingRiders.length && !trainingDeliveries.length) return null;
    const fullCfg = { ...cfg, ...trainingCfg };
    const cost = totalCost(trainingRiders, fullCfg);
    let totalTrips = 0, assignedCount = 0;
    const tripDetails = [];
    const deviations = [];
    for (let ri = 0; ri < trainingRiders.length; ri++) {
      const rider = trainingRiders[ri];
      for (let ti = 0; ti < rider.trips.length; ti++) {
        const trip = rider.trips[ti];
        totalTrips++;
        assignedCount += trip.deliveries.length;
        if (trip.arrivalTimes) {
          for (let di = 0; di < trip.deliveries.length; di++) {
            deviations.push(Math.abs(trip.arrivalTimes[di] - trip.deliveries[di].slot));
          }
          tripDetails.push({
            riderIdx: ri, tripIdx: ti,
            deliveryCount: trip.deliveries.length,
            departure: trip.departureTime,
            returnT: tripReturnTime(trip),
            avgDev: trip.deliveries.length ? tripDeviation(trip) / trip.deliveries.length : 0,
          });
        }
      }
    }
    const avgDev = deviations.length ? deviations.reduce((a, b) => a + b, 0) / deviations.length : 0;
    const maxDev = deviations.length ? Math.max(...deviations) : 0;
    const usedRiders = trainingRiders.filter((r) => r.trips.length > 0).length;
    return {
      cost: Math.round(cost * 10) / 10,
      totalTrips,
      assignedCount,
      totalDeliveries: trainingDeliveries.length,
      avgDev,
      maxDev,
      usedRiders,
      totalRiders: cfg.numRiders,
      tripDetails,
    };
  }, [trainingRiders, trainingDeliveries, cfg, trainingCfg]);

  // ── Render ──
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0f172a", color: "#e2e8f0", fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace", fontSize: 13 }}>

      {/* ── HEADER ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "#1e293b", borderBottom: "1px solid #334155", flexShrink: 0, flexWrap: "wrap" }}>
        <span style={{ fontSize: 18, marginRight: 8 }}>🍕</span>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: 1 }}>DELIVERY PLANNER</span>
        <div style={{ flex: 1 }} />
        <button onClick={loadPreset} style={btnStyle("#6366f1")}>Carica preset Padova</button>
        <button onClick={startNewOrder} disabled={mode !== "view"} style={btnStyle("#22c55e", mode !== "view")}>+ Nuovo ordine</button>
        <button onClick={resetAll} style={btnStyle("#64748b")}>Reset</button>
        <button onClick={() => setShowConfig(!showConfig)} style={btnStyle("#475569")}>
          {showConfig ? "Chiudi config" : "⚙ Config"}
        </button>
        <button onClick={() => { setTrainingMode((m) => !m); setTrainingPlacing(false); }} style={btnStyle(trainingMode ? "#f59e0b" : "#7c3aed")}>
          {trainingMode ? "← Esci allenamento" : "🎯 Allenamento"}
        </button>
      </div>

      {/* ── CONFIG PANEL ── */}
      {showConfig && (
        <div style={{ padding: "12px 16px", background: "#1e293b", borderBottom: "1px solid #334155", display: "flex", flexWrap: "wrap", gap: "12px 24px", alignItems: "center" }}>
          {[
            ["Fattorini", "numRiders", 1, 10, 1],
            ["Capacità pizze", "pizzeCapacity", 1, 20, 1],
            ["T max (min)", "tMaxMin", 10, 60, 5],
            ["Min partenza pre-slot (min)", "earlyToleranceMin", 0, 30, 1],
            ["Ritardo max (min)", "lateToleranceMin", 0, 30, 1],
            ["Detour factor", "detourFactor", 1.0, 2.0, 0.1],
            ["Velocità (km/h)", "avgSpeedKmh", 10, 50, 5],
            ["Sosta (min)", "stopTimeMin", 1, 10, 1],
            ["Penalità nuovo giro", "newTripPenalty", 1.0, 3.0, 0.1],
            ["Max consegne/giro", "maxDeliveriesPerTrip", 1, 10, 1],
            ["Tolleranza distanza (min/km)", "distToleranceFactor", 0, 3.0, 0.1],
            ["Durata slot (min)", "slotDurationMin", 5, 30, 5],
            ["Peso deviazione", "deviationWeight", 0, 5.0, 0.1],
            ["Elasticità spaziale", "spatialElasticity", 0.5, 30.0, 0.5],
          ].map(([label, key, min, max, step]) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span style={{ color: "#94a3b8" }}>{label}</span>
              <input type="number" value={cfg[key]} min={min} max={max} step={step}
                onChange={(e) => setCfg((c) => ({ ...c, [key]: parseFloat(e.target.value) || 0 }))}
                style={{ width: 60, background: "#0f172a", border: "1px solid #475569", borderRadius: 4, padding: "3px 6px", color: "#e2e8f0", fontSize: 12 }}
              />
            </label>
          ))}
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ color: "#94a3b8" }}>Metodo costo</span>
            <select value={cfg.costMethod}
              onChange={(e) => setCfg((c) => ({ ...c, costMethod: e.target.value }))}
              style={{ background: "#0f172a", border: "1px solid #475569", borderRadius: 4, padding: "3px 6px", color: "#e2e8f0", fontSize: 12 }}
            >
              <option value="perConsegna">Per consegna (V1)</option>
              <option value="savings">Savings (V3)</option>
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={cfg.availabilityConstraint}
              onChange={(e) => setCfg((c) => ({ ...c, availabilityConstraint: e.target.checked }))} />
            <span style={{ color: "#94a3b8" }}>Vincolo disponibilità slot</span>
          </label>
        </div>
      )}

      {/* ── MAIN AREA ── */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>

        {/* ── TRAINING: LEFT PARAMS PANEL ── */}
        {trainingMode && (
          <div style={{ width: 230, background: "#1e293b", borderRight: "1px solid #334155", overflowY: "auto", flexShrink: 0, padding: "12px 10px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase", marginBottom: 14 }}>
              Parametri Phase 2
            </div>
            {PHASE2_PARAMS.map(([label, key, min, max, step]) => (
              <div key={key} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>{label}</span>
                  <input
                    type="number" value={trainingCfg[key]} min={min} max={max} step={step}
                    onChange={(e) => setTrainingCfg((c) => ({ ...c, [key]: parseFloat(e.target.value) || 0 }))}
                    style={{ width: 52, background: "#0f172a", border: "1px solid #475569", borderRadius: 4, padding: "2px 5px", color: "#e2e8f0", fontSize: 11, textAlign: "right" }}
                  />
                </div>
                <input
                  type="range" className="training-slider"
                  value={trainingCfg[key]} min={min} max={max} step={step}
                  onChange={(e) => setTrainingCfg((c) => ({ ...c, [key]: parseFloat(e.target.value) }))}
                />
              </div>
            ))}
            <details style={{ marginTop: 16 }}>
              <summary style={{ fontSize: 11, color: "#64748b", cursor: "pointer", marginBottom: 8, userSelect: "none" }}>
                Parametri fissi (Phase 1)
              </summary>
              {[
                ["Fattorini", "numRiders"], ["Capac. pizze", "pizzeCapacity"],
                ["T max (min)", "tMaxMin"], ["Early tol.", "earlyToleranceMin"],
                ["Late tol.", "lateToleranceMin"], ["Detour factor", "detourFactor"],
                ["Velocità km/h", "avgSpeedKmh"], ["Sosta (min)", "stopTimeMin"],
              ].map(([label, key]) => (
                <div key={key} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", padding: "2px 0" }}>
                  <span>{label}</span>
                  <span style={{ color: "#94a3b8" }}>{cfg[key]}</span>
                </div>
              ))}
            </details>
          </div>
        )}

        {/* ── MAP (always mounted to preserve Leaflet instance) ── */}
        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          <div ref={mapRef} style={{ width: "100%", height: "100%" }} />

          {/* Placing mode overlay */}
          {mode === "placing" && !trainingMode && (
            <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: "#fbbf24", color: "#0f172a", padding: "8px 20px", borderRadius: 8, fontWeight: 700, fontSize: 13, boxShadow: "0 4px 20px rgba(251,191,36,.4)" }}>
              📍 Clicca sulla mappa per posizionare la consegna
            </div>
          )}
          {trainingMode && trainingPlacing && (
            <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 1000, background: "#6366f1", color: "#fff", padding: "8px 20px", borderRadius: 8, fontWeight: 700, fontSize: 13, boxShadow: "0 4px 20px rgba(99,102,241,.5)" }}>
              📍 Clicca sulla mappa per aggiungere una consegna
            </div>
          )}

          {!mapReady && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#0f172a", zIndex: 1000 }}>
              <span style={{ fontSize: 16 }}>Caricamento mappa...</span>
            </div>
          )}
        </div>

        {/* ── TRAINING: RIGHT METRICS PANEL ── */}
        {trainingMode && (
          <TrainingMetricsPanel
            metrics={trainingMetrics}
            trainingN={trainingN}
            setTrainingN={setTrainingN}
            onNewScenario={generateNewScenario}
            onClearDeliveries={clearTrainingDeliveries}
            trainingPlacing={trainingPlacing}
            setTrainingPlacing={setTrainingPlacing}
            trainingNewPizzas={trainingNewPizzas}
            setTrainingNewPizzas={setTrainingNewPizzas}
            trainingNewSlot={trainingNewSlot}
            setTrainingNewSlot={setTrainingNewSlot}
            slots={slots}
          />
        )}

        {/* ── SIDE PANEL (normal mode) ── */}
        {!trainingMode && <div style={{ width: 320, background: "#1e293b", borderLeft: "1px solid #334155", display: "flex", flexDirection: "column", overflowY: "auto", flexShrink: 0 }}>

          {mode === "view" && !availableSlots && (
            <div style={{ padding: 20 }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#94a3b8", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Stato fattorini</h3>
              {riders.map((r, ri) => (
                <div key={ri} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 12, height: 12, borderRadius: "50%", background: RIDER_COLORS[ri] }} />
                    <span style={{ fontWeight: 600 }}>Fattorino #{ri + 1}</span>
                    <span style={{ color: "#64748b", fontSize: 11 }}>{r.trips.length} giri</span>
                  </div>
                  {r.trips.length === 0 && <div style={{ color: "#475569", fontSize: 11, paddingLeft: 20 }}>Nessun giro</div>}
                  {r.trips.map((trip, ti) => (
                    <div key={ti}
                      onClick={() => setSelectedTripKey(selectedTripKey === `${ri}-${ti}` ? null : `${ri}-${ti}`)}
                      style={{
                        padding: "6px 8px", marginLeft: 20, marginBottom: 4, borderRadius: 6, cursor: "pointer", fontSize: 11,
                        background: selectedTripKey === `${ri}-${ti}` ? RIDER_COLORS[ri] + "30" : "#0f172a",
                        border: `1px solid ${selectedTripKey === `${ri}-${ti}` ? RIDER_COLORS[ri] : "#334155"}`,
                      }}>
                      <div style={{ fontWeight: 600 }}>
                        {timeStr(trip.departureTime)} → {timeStr(tripReturnTime(trip))}
                        <span style={{ color: "#94a3b8", fontWeight: 400 }}> · {trip.totalPizzas}🍕 · {trip.deliveries.length} cons.</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {(mode === "placing" || mode === "selecting") && (
            <div style={{ padding: 20 }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#fbbf24", fontWeight: 600 }}>Nuovo ordine</h3>

              {newOrderPos ? (
                <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 12 }}>
                  📍 {newOrderPos.lat.toFixed(4)}, {newOrderPos.lng.toFixed(4)}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>Clicca sulla mappa...</div>
              )}

              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <span style={{ color: "#94a3b8", fontSize: 12 }}>Pizze:</span>
                <input type="number" value={newOrderPizzas} min={1} max={cfg.pizzeCapacity}
                  onChange={(e) => setNewOrderPizzas(Math.max(1, parseInt(e.target.value) || 1))}
                  style={{ width: 60, background: "#0f172a", border: "1px solid #475569", borderRadius: 4, padding: "4px 8px", color: "#e2e8f0", fontSize: 13 }}
                />
              </label>

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={findSlots} disabled={!newOrderPos}
                  style={btnStyle("#22c55e", !newOrderPos)}>
                  Calcola slot
                </button>
                <button onClick={cancelOrder} style={btnStyle("#64748b")}>Annulla</button>
              </div>

              {/* Available slots */}
              {availableSlots && (
                <div style={{ marginTop: 20 }}>
                  <h4 style={{ margin: "0 0 8px", fontSize: 12, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 1 }}>
                    Slot disponibili ({availableSlots.length})
                  </h4>
                  {availableSlots.length === 0 && (
                    <div style={{ color: "#ef4444", fontSize: 12 }}>Nessuno slot disponibile</div>
                  )}
                  <div style={{ maxHeight: 400, overflowY: "auto" }}>
                    {availableSlots.map((sr, i) => {
                      const isHover = previewSlot === sr;
                      // Find which rider has the new delivery
                      const newDelRi = sr.newRiders.findIndex(r =>
                        r.trips.some(t => t.deliveries.some(d => d.id === sr.orderId))
                      );
                      const rColor = RIDER_COLORS[Math.max(0, newDelRi) % RIDER_COLORS.length];
                      const totalTrips = sr.newRiders.reduce((s, r) => s + r.trips.length, 0);
                      return (
                        <div key={i}
                          onMouseEnter={() => setPreviewSlot(sr)}
                          onMouseLeave={() => setPreviewSlot(null)}
                          onClick={() => confirmSlot(sr)}
                          style={{
                            padding: "8px 10px", marginBottom: 4, borderRadius: 6, cursor: "pointer",
                            background: isHover ? rColor + "25" : "#0f172a",
                            border: `1px solid ${isHover ? rColor : "#334155"}`,
                            transition: "all .15s",
                          }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span style={{ fontWeight: 700, fontSize: 14 }}>{timeStr(sr.slot)}</span>
                            <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                              <div style={{ width: 8, height: 8, borderRadius: "50%", background: rColor }} />
                              <span style={{ fontSize: 11 }}>#{newDelRi + 1}</span>
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
                            {totalTrips} giri · costo +{Math.round(sr.cost * 60)}s
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>}

      </div>

      {/* ── TIMELINE (Gantt) ── */}
      <div style={{ height: 180, background: "#1e293b", borderTop: "1px solid #334155", flexShrink: 0, overflowX: "auto", overflowY: "hidden" }}>
        <Timeline
          riders={trainingMode ? trainingRiders : riders}
          slots={slots}
          timeRange={trainingMode ? trainingTimeRange : timeRange}
          selectedTripKey={trainingMode ? null : selectedTripKey}
          setSelectedTripKey={trainingMode ? () => {} : setSelectedTripKey}
          previewSlot={trainingMode ? null : previewSlot}
          cfg={trainingMode ? { ...cfg, ...trainingCfg } : cfg}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TIMELINE COMPONENT
// ═══════════════════════════════════════════════════════════════════

function Timeline({ riders, slots, timeRange, selectedTripKey, setSelectedTripKey, previewSlot }) {
  const containerRef = useRef(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const PAD_L = 90, PAD_R = 20;
  const LANE_H = 44;
  const chartW = Math.max(width - PAD_L - PAD_R, 200);
  const totalH = riders.length * LANE_H + 36;
  const { min: tMin, max: tMax } = timeRange;
  const tScale = (t) => PAD_L + ((t - tMin) / (tMax - tMin)) * chartW;

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", minWidth: 600 }}>
      <svg width={width} height={totalH} style={{ display: "block" }}>
        {/* Time axis */}
        {slots.map((s) => {
          const x = tScale(s);
          return (
            <g key={s}>
              <line x1={x} y1={0} x2={x} y2={totalH} stroke="#334155" strokeWidth={1} strokeDasharray="4 4" />
              <text x={x} y={totalH - 4} textAnchor="middle" fill="#64748b" fontSize={10} fontFamily="monospace">{timeStr(s)}</text>
            </g>
          );
        })}

        {/* Rider lanes */}
        {riders.map((rider, ri) => {
          const y = ri * LANE_H + 8;
          const color = RIDER_COLORS[ri % RIDER_COLORS.length];
          return (
            <g key={ri}>
              {/* Lane background */}
              <rect x={0} y={y} width={width} height={LANE_H - 4} rx={4} fill={ri % 2 === 0 ? "#0f172a40" : "transparent"} />
              {/* Label */}
              <text x={12} y={y + LANE_H / 2 - 2} dominantBaseline="middle" fill={color} fontSize={11} fontWeight="700" fontFamily="monospace">
                Fattorino #{ri + 1}
              </text>

              {/* Trips */}
              {rider.trips.map((trip, ti) => {
                const tripKey = `${ri}-${ti}`;
                const isSel = selectedTripKey === tripKey;
                const x1 = tScale(trip.departureTime);
                const x2 = tScale(tripReturnTime(trip));
                const h = LANE_H - 14;
                const ty = y + 5;
                return (
                  <g key={ti} style={{ cursor: "pointer", opacity: previewSlot ? 0.2 : 1 }} onClick={() => setSelectedTripKey(isSel ? null : tripKey)}>
                    <rect x={x1} y={ty} width={Math.max(x2 - x1, 4)} height={h} rx={5}
                      fill={color + (isSel ? "50" : "30")}
                      stroke={isSel ? color : color + "80"} strokeWidth={isSel ? 2 : 1} />
                    {/* Delivery dots */}
                    {trip.arrivalTimes && trip.arrivalTimes.map((at, di) => {
                      const dx = tScale(at);
                      return (
                        <g key={di}>
                          <circle cx={dx} cy={ty + h / 2} r={5} fill={color} stroke="#fff" strokeWidth={1.5} />
                          <text x={dx} y={ty + h / 2} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={7} fontWeight="700">
                            {di + 1}
                          </text>
                        </g>
                      );
                    })}
                    {/* Pizza count */}
                    <text x={x1 + 6} y={ty + 10} fill="#e2e8f0" fontSize={9} fontFamily="monospace">
                      {trip.totalPizzas}🍕
                    </text>
                  </g>
                );
              })}

              {/* Preview trips from re-optimized assignment */}
              {previewSlot && previewSlot.newRiders && previewSlot.newRiders[ri] &&
                previewSlot.newRiders[ri].trips.map((trip, pti) => {
                  const px1 = tScale(trip.departureTime);
                  const px2 = tScale(tripReturnTime(trip));
                  const ph = LANE_H - 14;
                  const py = y + 5;
                  return (
                    <rect key={`preview-${pti}`} x={px1} y={py} width={Math.max(px2 - px1, 4)} height={ph} rx={5}
                      fill={color + "20"} stroke={color} strokeWidth={2} strokeDasharray="4 3" />
                  );
                })
              }
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// TRAINING METRICS PANEL
// ═══════════════════════════════════════════════════════════════════

function TrainingMetricsPanel({
  metrics, trainingN, setTrainingN, onNewScenario, onClearDeliveries,
  trainingPlacing, setTrainingPlacing, trainingNewPizzas, setTrainingNewPizzas,
  trainingNewSlot, setTrainingNewSlot, slots,
}) {
  const pct = metrics ? Math.round((metrics.assignedCount / Math.max(metrics.totalDeliveries, 1)) * 100) : 0;
  return (
    <div style={{ width: 280, background: "#1e293b", borderLeft: "1px solid #334155", overflowY: "auto", flexShrink: 0, display: "flex", flexDirection: "column" }}>

      {/* Scenario casuale */}
      <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid #334155" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>
          Scenario casuale
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>Consegne:</span>
          <button onClick={() => setTrainingN((n) => Math.max(1, n - 1))} style={{ ...btnStyle("#334155"), padding: "2px 8px", fontSize: 13 }}>−</button>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", minWidth: 20, textAlign: "center" }}>{trainingN}</span>
          <button onClick={() => setTrainingN((n) => Math.min(20, n + 1))} style={{ ...btnStyle("#334155"), padding: "2px 8px", fontSize: 13 }}>+</button>
        </div>
        <button onClick={onNewScenario} style={{ ...btnStyle("#6366f1"), width: "100%", padding: "7px 0" }}>
          🎲 Nuovo Scenario
        </button>
      </div>

      {/* Aggiunta manuale */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #334155" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
          Aggiunta manuale
        </div>
        {trainingPlacing ? (
          <>
            <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 700, marginBottom: 8 }}>
              📍 Clicca sulla mappa...
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: "#94a3b8" }}>Pizze:</span>
              <button onClick={() => setTrainingNewPizzas((n) => Math.max(1, n - 1))} style={{ ...btnStyle("#334155"), padding: "1px 7px", fontSize: 13 }}>−</button>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", minWidth: 16, textAlign: "center" }}>{trainingNewPizzas}</span>
              <button onClick={() => setTrainingNewPizzas((n) => Math.min(8, n + 1))} style={{ ...btnStyle("#334155"), padding: "1px 7px", fontSize: 13 }}>+</button>
            </div>
            <div style={{ marginBottom: 8 }}>
              <select
                value={trainingNewSlot}
                onChange={(e) => setTrainingNewSlot(parseInt(e.target.value))}
                style={{ width: "100%", background: "#0f172a", border: "1px solid #475569", borderRadius: 4, padding: "4px 6px", color: "#e2e8f0", fontSize: 11 }}
              >
                {slots.map((s) => <option key={s} value={s}>{timeStr(s)}</option>)}
              </select>
            </div>
            <button onClick={() => setTrainingPlacing(false)} style={{ ...btnStyle("#475569"), width: "100%", padding: "5px 0" }}>
              Annulla
            </button>
          </>
        ) : (
          <button onClick={() => setTrainingPlacing(true)} style={{ ...btnStyle("#0ea5e9"), width: "100%", padding: "7px 0" }}>
            📍 Aggiungi consegna
          </button>
        )}
        <button onClick={onClearDeliveries} style={{ ...btnStyle("#334155"), width: "100%", padding: "5px 0", marginTop: 6 }}>
          🗑️ Svuota tutto
        </button>
      </div>

      {/* Metrics */}
      <div style={{ padding: "12px 12px 4px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>
          Metriche
        </div>
        {metrics ? (
          <>
            {[
              ["Costo totale", metrics.cost.toFixed(1), metricColor(metrics.avgDev, 3, 8)],
              ["Giri totali", metrics.totalTrips, null],
              ["Consegne ass.", `${metrics.assignedCount} / ${metrics.totalDeliveries}`, metricColor(100 - pct, 0, 20)],
              ["Rider in uso", `${metrics.usedRiders} / ${metrics.totalRiders}`, null],
              ["Dev. media", `${metrics.avgDev.toFixed(1)} min`, metricColor(metrics.avgDev, 3, 8)],
              ["Dev. massima", `${metrics.maxDev.toFixed(1)} min`, metricColor(metrics.maxDev, 6, 15)],
            ].map(([label, value, color]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #0f172a" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {color && <div style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />}
                  {!color && <div style={{ width: 7, height: 7, flexShrink: 0 }} />}
                  <span style={{ fontSize: 11, color: "#94a3b8" }}>{label}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: color || "#e2e8f0" }}>{value}</span>
              </div>
            ))}
          </>
        ) : (
          <div style={{ color: "#475569", fontSize: 11 }}>Nessun dato</div>
        )}
      </div>

      {/* Trip detail */}
      {metrics && metrics.tripDetails.length > 0 && (
        <div style={{ padding: "10px 12px", flex: 1, overflowY: "auto" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
            Dettaglio giri
          </div>
          {metrics.tripDetails.map((td, i) => (
            <div key={i} style={{
              padding: "7px 8px", marginBottom: 5, borderRadius: 6,
              background: "#0f172a", border: `1px solid ${RIDER_COLORS[td.riderIdx % RIDER_COLORS.length]}40`,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: RIDER_COLORS[td.riderIdx % RIDER_COLORS.length] }}>
                  Rider {td.riderIdx + 1} · Giro {td.tripIdx + 1}
                </span>
                <span style={{ fontSize: 10, color: "#64748b" }}>{td.deliveryCount} cons.</span>
              </div>
              <div style={{ fontSize: 10, color: "#94a3b8" }}>
                {timeStr(td.departure)} → {timeStr(td.returnT)}
              </div>
              <div style={{ fontSize: 10, color: metricColor(td.avgDev, 3, 8) }}>
                dev media: {td.avgDev.toFixed(1)} min
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════

function btnStyle(bg, disabled = false) {
  return {
    padding: "6px 14px", borderRadius: 6, border: "none", cursor: disabled ? "not-allowed" : "pointer",
    background: disabled ? "#334155" : bg, color: disabled ? "#64748b" : "#fff",
    fontWeight: 600, fontSize: 12, fontFamily: "inherit", transition: "all .15s",
    opacity: disabled ? 0.6 : 1,
  };
}
