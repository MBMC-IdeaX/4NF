// Real-time Fleet Tracking & Motion Simulator for Kathmandu Transit
// Simulates live GPS telemetry, stop dwell times, traffic speed, and seat occupancy.

import { VALLEY_ROUTES, VENDORS } from '../data/valley-routes';

// Interpolate between two lat/lon coordinates
function interpolate(p1, p2, t) {
  return {
    lat: p1.lat + (p2.lat - p1.lat) * t,
    lon: p1.lon + (p2.lon - p1.lon) * t,
  };
}

class FleetSimulationEngine {
  constructor() {
    this.routes = JSON.parse(JSON.stringify(VALLEY_ROUTES));
    this.listeners = new Set();
    this.timer = null;
    this.lastTick = Date.now();
    this.initFleet();
    this.start();
  }

  initFleet() {
    for (const route of this.routes) {
      for (const bus of route.buses) {
        bus.routeId = route.id;
        bus.routeNumber = route.number;
        bus.from = route.from;
        bus.to = route.to;
        bus.fromNe = route.fromNe;
        bus.toNe = route.toNe;
        bus.routeColor = route.color;
        bus.stopsCount = route.stops.length;
        bus.totalDistanceKm = route.distanceKm;
        bus.fareNormal = route.fareNormal;
        bus.fareStudent = route.fareStudent;
        bus.vendorInfo = VENDORS[bus.vendor] || VENDORS.nepal;

        // Compute initial coordinates
        this.updateBusPhysics(bus, route, 0);
      }
    }
  }

  updateBusPhysics(bus, route, deltaSec) {
    const stops = route.stops;
    const totalStops = stops.length;
    if (totalStops < 2) return;

    // Advance progress based on current speed
    // 1 km/h = 1000m / 3600s
    if (deltaSec > 0) {
      // Natural traffic speed variation: 15 to 38 km/h, occasional stop crawl
      const baseSpeed = bus.direction === 'forward' ? 24 : 22;
      const speedWiggle = Math.sin(Date.now() / 4000 + bus.id.charCodeAt(1)) * 10;
      bus.speedKmh = Math.max(0, Math.min(42, Math.round(baseSpeed + speedWiggle)));

      // Step progress along the line
      const speedMps = (bus.speedKmh * 1000) / 3600;
      const distTraveledM = speedMps * deltaSec;
      const totalRoadM = route.distanceKm * 1000;
      const progressDelta = distTraveledM / totalRoadM;

      if (bus.direction === 'forward') {
        bus.progress += progressDelta;
        if (bus.progress >= 1.0) {
          bus.progress = 1.0;
          bus.direction = 'backward';
          // At terminal stop, reset dwell
          bus.speedKmh = 0;
        }
      } else {
        bus.progress -= progressDelta;
        if (bus.progress <= 0.0) {
          bus.progress = 0.0;
          bus.direction = 'forward';
          bus.speedKmh = 0;
        }
      }
    }

    // Determine current segment between stops
    const effectiveProgress = Math.max(0, Math.min(1, bus.progress));
    const rawIndex = effectiveProgress * (totalStops - 1);
    const segIdx = Math.min(Math.floor(rawIndex), totalStops - 2);
    const segT = rawIndex - segIdx;

    const stopA = stops[segIdx];
    const stopB = stops[segIdx + 1];

    const pos = interpolate(stopA, stopB, segT);
    bus.lat = pos.lat;
    bus.lon = pos.lon;

    if (bus.direction === 'forward') {
      bus.currentStop = stopA;
      bus.nextStop = stopB;
      const distToNextKm = (stopB.km - stopA.km) * (1 - segT);
      bus.distToNextKm = Number(distToNextKm.toFixed(1));
      bus.etaMinutes = Math.max(1, Math.round((distToNextKm / Math.max(12, bus.speedKmh)) * 60));
    } else {
      bus.currentStop = stopB;
      bus.nextStop = stopA;
      const distToNextKm = (stopB.km - stopA.km) * segT;
      bus.distToNextKm = Number(distToNextKm.toFixed(1));
      bus.etaMinutes = Math.max(1, Math.round((distToNextKm / Math.max(12, bus.speedKmh)) * 60));
    }

    // Dynamic passenger boarding simulation at stops
    if (deltaSec > 0 && Math.random() < 0.1) {
      const change = Math.floor(Math.random() * 5) - 2; // -2 to +2
      bus.occupiedSeats = Math.max(8, Math.min(bus.capacity + 6, bus.occupiedSeats + change));
    }

    bus.availableSeats = Math.max(0, bus.capacity - bus.occupiedSeats);
    const occRatio = bus.occupiedSeats / bus.capacity;
    if (occRatio < 0.75) {
      bus.crowdLevel = 'available';
      bus.crowdLabel = `${bus.availableSeats} Available`;
      bus.crowdColor = '#16a34a';
      bus.crowdNe = `${bus.availableSeats} सिट खाली`;
    } else if (occRatio <= 1.0) {
      bus.crowdLevel = 'few_seats';
      bus.crowdLabel = `${bus.availableSeats} Seats Left`;
      bus.crowdColor = '#d97706';
      bus.crowdNe = `${bus.availableSeats} सिट बाँकी`;
    } else {
      const standing = bus.occupiedSeats - bus.capacity;
      bus.crowdLevel = 'standing';
      bus.crowdLabel = `Standing Only (+${standing})`;
      bus.crowdColor = '#dc2626';
      bus.crowdNe = `उभिने ठाउँ मात्र (+${standing})`;
    }
  }

  tick() {
    const now = Date.now();
    const deltaSec = (now - this.lastTick) / 1000;
    this.lastTick = now;

    for (const route of this.routes) {
      for (const bus of route.buses) {
        this.updateBusPhysics(bus, route, deltaSec);
      }
    }

    this.notify();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1500); // 1.5s updates for fluid animation
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  notify() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('Fleet listener error', err);
      }
    }
  }

  getSnapshot() {
    const allBuses = [];
    for (const route of this.routes) {
      for (const bus of route.buses) {
        allBuses.push({ ...bus });
      }
    }
    return {
      routes: this.routes,
      allBuses,
      totalBuses: allBuses.length,
      timestamp: Date.now(),
    };
  }
}

// Global singleton instance
export const fleetEngine = new FleetSimulationEngine();
