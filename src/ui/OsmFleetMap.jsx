import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Custom HTML DivIcon for Live Buses
function createBusIcon(bus, isSelected) {
  const vColor = (/^#[0-9a-f]{3,8}$/i.test(bus.vendorInfo?.color ?? '') ? bus.vendorInfo.color : '#a8202f');
  const size = isSelected ? 48 : 40;

  const html = `
    <div style="
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      cursor: pointer;
      transform: translate(-50%, -50%);
    ">
      <!-- Live GNSS Pulse Beacon -->
      <span style="
        position: absolute;
        top: 2px;
        width: ${size}px;
        height: ${size}px;
        background: ${vColor};
        opacity: 0.35;
        border-radius: 50%;
        animation: pulse-ring 2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
      "></span>

      <!-- Vehicle Capsule -->
      <div style="
        position: relative;
        background: #16130f;
        color: #fff;
        border: 2px solid ${isSelected ? '#f59e0b' : vColor};
        border-radius: 999px;
        padding: 3px 8px;
        display: flex;
        align-items: center;
        gap: 5px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        font-family: var(--font-body, system-ui);
        font-size: 11px;
        font-weight: 700;
        white-space: nowrap;
      ">
        <span style="
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: ${bus.speedKmh > 0 ? '#22c55e' : '#f59e0b'};
          display: inline-block;
        "></span>
        <span aria-hidden="true">??</span><span style="color: #fff;">${escapeHtml(bus.plateStr || bus.id)}</span>
        <span data-speed style="
          background: rgba(255,255,255,0.18);
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 9.5px;
          font-weight: 600;
          color: #f1f5f9;
        ">${escapeHtml(bus.speedKmh)} km/h</span>
      </div>

      <!-- Pointer Stem -->
      <div style="
        width: 0;
        height: 0;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-top: 6px solid #16130f;
        margin-top: -1px;
      "></div>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'custom-bus-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// Stop Pin Marker
function createStopIcon(stop, isTerminal) {
  const html = `
    <div style="
      width: ${isTerminal ? '16px' : '11px'};
      height: ${isTerminal ? '16px' : '11px'};
      background: ${isTerminal ? '#a8202f' : '#ffffff'};
      border: 2.5px solid ${isTerminal ? '#ffffff' : '#334155'};
      border-radius: 50%;
      box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      cursor: pointer;
    "></div>
  `;
  return L.divIcon({
    html,
    className: 'custom-stop-marker',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export default function OsmFleetMap({
  buses = [],
  routes = [],
  selectedRouteId = null,
  selectedBusId = null,
  onSelectBus = () => {},
  onSelectRoute = () => {},
  height = '500px',
  interactive = true,
}) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersRef = useRef(new Map());
  const routeLayersRef = useRef(new Map());
  const stopMarkersRef = useRef([]);

  const latest = useRef({});
  latest.current = { buses, onSelectBus, onSelectRoute };
  const [following, setFollowing] = useState(false);
  const geometry = JSON.stringify(routes.map(({ id, color, stops }) => ({ id, color, stops })));

  useEffect(() => setFollowing(false), [selectedBusId, selectedRouteId]);

  // Initialize Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapInstanceRef.current) return;

    // Kathmandu Valley Center [27.7050, 85.3200]
    const map = L.map(mapContainerRef.current, {
      center: [27.7085, 85.3240],
      zoom: 13,
      zoomControl: interactive,
      scrollWheelZoom: interactive,
      attributionControl: true,
    });

    // OpenStreetMap's own tiles: free, no API key, attribution required.
    // (CARTO's basemaps now answer every keyless request with an
    // "API key required" tile.) Fine for a demo's traffic; heavy use needs a
    // tile provider of our own, per the OSM tile usage policy.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    mapInstanceRef.current = map;

    // Ensure map tiles properly calibrate and fill container upon mounting or tab switching
    let frame;
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => map.invalidateSize({ pan: false })); };
    const observer = new ResizeObserver(resize);
    observer.observe(mapContainerRef.current);
    document.addEventListener('visibilitychange', resize);
    const pause = () => setFollowing(false);
    map.on('dragstart', pause);
    map.getContainer().addEventListener('wheel', pause);
    map.getContainer().addEventListener('pointerdown', pause);
    resize();

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', resize);
      map.getContainer().removeEventListener('wheel', pause);
      map.getContainer().removeEventListener('pointerdown', pause);
      cancelAnimationFrame(frame);
      markersRef.current.clear();
      routeLayersRef.current.clear();
      stopMarkersRef.current = [];
      map.remove();
      mapInstanceRef.current = null;
    };
  }, [interactive]);

  // Render Routes and Stops
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    // Clear old route polylines
    for (const [, layer] of routeLayersRef.current) {
      map.removeLayer(layer);
    }
    routeLayersRef.current.clear();

    // Clear old stop markers
    for (const sm of stopMarkersRef.current) {
      map.removeLayer(sm);
    }
    stopMarkersRef.current = [];

    // Filter routes to display
    const visibleRoutes = selectedRouteId
      ? routes.filter((r) => r.id === selectedRouteId)
      : routes;

    const allLatLons = [];

    for (const r of visibleRoutes) {
      const latLons = r.stops.map((s) => [s.lat, s.lon]);
      allLatLons.push(...latLons);

      const isFocused = selectedRouteId === r.id;

      // Draw polyline
      const line = L.polyline(latLons, {
        color: r.color || '#a8202f',
        weight: isFocused ? 5 : 3.5,
        opacity: isFocused ? 0.95 : 0.65,
        dashArray: isFocused ? null : '6, 6',
      }).addTo(map);

      line.on('click', () => latest.current.onSelectRoute(r.id));
      routeLayersRef.current.set(r.id, line);

      // Draw stops
      r.stops.forEach((s, idx) => {
        const isTerminal = idx === 0 || idx === r.stops.length - 1;
        const marker = L.marker([s.lat, s.lon], {
          icon: createStopIcon(s, isTerminal),
          zIndexOffset: isTerminal ? 100 : 50,
        }).addTo(map);

        marker.bindTooltip(
          `<strong>${escapeHtml(s.name)}</strong><br/><span style="color:#64748b">${escapeHtml(s.ne)}</span>`,
          { direction: 'top', offset: [0, -8] }
        );

        stopMarkersRef.current.push(marker);
      });
    }

    // Adjust bounds if user switched route
    if (allLatLons.length > 0) {
      map.fitBounds(L.latLngBounds(allLatLons), { padding: [40, 40], maxZoom: 14 });
    }
  }, [geometry, selectedRouteId, interactive]);

  // Update Bus Markers dynamically
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const currentMarkers = markersRef.current;
    const activeBusIds = new Set(buses.map((b) => b.id));

    // Remove deleted buses
    for (const [id, marker] of currentMarkers) {
      if (!activeBusIds.has(id)) {
        map.removeLayer(marker);
        currentMarkers.delete(id);
      }
    }

    // Add or update live bus positions smoothly
    for (const bus of buses) {
      if (!Number.isFinite(bus.lat) || !Number.isFinite(bus.lon)) continue;
      const latLng = [bus.lat, bus.lon];
      const isSelected = selectedBusId === bus.id;

      if (currentMarkers.has(bus.id)) {
        const m = currentMarkers.get(bus.id);
        m.setLatLng(latLng);
        const styleKey = JSON.stringify([isSelected, bus.vendorInfo?.color, bus.plateStr]);
        if (m.styleKey !== styleKey) { m.setIcon(createBusIcon(bus, isSelected)); m.styleKey = styleKey; }
        const speed = m.getElement()?.querySelector('[data-speed]');
        if (speed) speed.textContent = `${bus.speedKmh} km/h`;
      } else {
        const m = L.marker(latLng, {
          icon: createBusIcon(bus, isSelected),
          zIndexOffset: 500,
        }).addTo(map);

        m.on('click', () => { const fresh = latest.current.buses.find((b) => b.id === bus.id); if (fresh) latest.current.onSelectBus(fresh); });
        m.styleKey = JSON.stringify([isSelected, bus.vendorInfo?.color, bus.plateStr]);
        currentMarkers.set(bus.id, m);
      }
    }

    // Center on selected bus
    if (selectedBusId && following) {
      const selected = buses.find((b) => b.id === selectedBusId);
      if (selected && selected.lat && selected.lon) {
        map.panTo([selected.lat, selected.lon], { animate: true });
      }
    }
  }, [buses, selectedBusId, following, interactive]);

  return (
    <div style={{ position: 'relative', width: '100%', height, borderRadius: '14px', overflow: 'hidden' }}>
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%', background: '#f8fafc' }} />

      {selectedBusId ? <button type="button" onClick={() => setFollowing((v) => !v)} style={{ position: 'absolute', top: 12, right: 12, zIndex: 1000 }}>{following ? 'Pause follow' : 'Follow bus'}</button> : null}
      {/* Floating Map Legend & Attribution */}
      <div
        style={{
          position: 'absolute',
          bottom: '12px',
          left: '12px',
          zIndex: 1000,
          background: 'rgba(22, 19, 15, 0.88)',
          backdropFilter: 'blur(8px)',
          padding: '8px 12px',
          borderRadius: '8px',
          color: '#f8fafc',
          fontSize: '11px',
          display: 'flex',
          gap: '12px',
          alignItems: 'center',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        }}
      >
        <span style={{ fontWeight: 700, color: '#ffb21a', letterSpacing: '0.06em' }}>SIMULATED</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#16a34a' }}></span>
          मयुर
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#0284c7' }}></span>
          निलो
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#a8202f' }}></span>
          रातो
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ea580c' }}></span>
          पहेँलो
        </span>
      </div>

      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(0.6); opacity: 0.8; }
          100% { transform: scale(1.6); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
