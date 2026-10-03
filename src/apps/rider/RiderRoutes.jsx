import { useState, useEffect, useMemo } from 'react';
import OsmFleetMap from '../../ui/OsmFleetMap';
import LiveBusStatusCard from '../../ui/LiveBusStatusCard';
import { fleetEngine } from '../../lib/fleet-simulator';
import { findRoutesByStation, VENDORS } from '../../data/valley-routes';
import { Icon, Button } from '../../ui';

export default function RiderRoutes({ go, onBack }) {
  const [snapshot, setSnapshot] = useState(() => fleetEngine.getSnapshot());
  const [stationQuery, setStationQuery] = useState('');
  const [selectedRouteId, setSelectedRouteId] = useState('R1');
  const [selectedBusId, setSelectedBusId] = useState(null);
  const [viewMode, setViewMode] = useState('split'); // 'split' | 'map' | 'list'

  // Subscribe to the simulated demo fleet
  useEffect(() => {
    return fleetEngine.subscribe(setSnapshot);
  }, []);

  // Filter routes by station query
  const filteredRoutes = useMemo(() => {
    return findRoutesByStation(stationQuery);
  }, [stationQuery]);

  // Selected route object
  const activeRoute = useMemo(() => {
    return snapshot.routes.find((r) => r.id === selectedRouteId) || snapshot.routes[0];
  }, [snapshot.routes, selectedRouteId]);

  // Selected bus object
  const activeBus = useMemo(() => {
    if (!selectedBusId) return activeRoute?.buses[0] || null;
    return snapshot.allBuses.find((b) => b.id === selectedBusId) || null;
  }, [snapshot.allBuses, selectedBusId, activeRoute]);

  return (
    <div style={{ padding: '16px', maxWidth: '1080px', margin: '0 auto', fontFamily: 'var(--font-body, system-ui)' }}>
      {/* Top Header with Back Button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <button
            type="button"
            onClick={onBack || (() => go('home'))}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-brand, #a8202f)',
              fontSize: '13px',
              fontWeight: '700',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: 0,
              marginBottom: '4px',
            }}
          >
            ← Back to Home / फर्कनुहोस्
          </button>
          <h1 style={{ fontSize: '26px', fontWeight: '800', margin: 0, color: '#16130f' }}>
            मार्ग र बसहरू · Routes
          </h1>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '13.5px' }}>
            Valley routes, stops and fares. Bus positions and seats on this screen are a simulated demo fleet, not live buses.
          </p>
        </div>

        {/* View Mode Toggle */}
        <div style={{ display: 'flex', background: '#e2e8f0', borderRadius: '10px', padding: '3px' }}>
          <button
            type="button"
            onClick={() => setViewMode('split')}
            style={{
              padding: '6px 12px',
              borderRadius: '8px',
              border: 'none',
              fontSize: '12px',
              fontWeight: '700',
              cursor: 'pointer',
              background: viewMode === 'split' ? '#fff' : 'transparent',
              color: viewMode === 'split' ? '#0f172a' : '#64748b',
              boxShadow: viewMode === 'split' ? '0 2px 4px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            Split View
          </button>
          <button
            type="button"
            onClick={() => setViewMode('map')}
            style={{
              padding: '6px 12px',
              borderRadius: '8px',
              border: 'none',
              fontSize: '12px',
              fontWeight: '700',
              cursor: 'pointer',
              background: viewMode === 'map' ? '#fff' : 'transparent',
              color: viewMode === 'map' ? '#0f172a' : '#64748b',
              boxShadow: viewMode === 'map' ? '0 2px 4px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            Full Map
          </button>
        </div>
      </div>

      {/* Search Input: Filter Routes by Station (Like Sajha Plus) */}
      <div style={{ position: 'relative', marginBottom: '18px' }}>
        <input
          type="text"
          placeholder="Filter Routes by Station (e.g. Tripureshwor, Ratnapark, Lagankhel)..."
          value={stationQuery}
          onChange={(e) => setStationQuery(e.target.value)}
          style={{
            width: '100%',
            padding: '14px 16px 14px 44px',
            borderRadius: '12px',
            border: '2px solid #e2e8f0',
            fontSize: '15px',
            background: '#ffffff',
            boxSizing: 'border-box',
            outline: 'none',
            boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: '16px',
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: '16px',
            color: '#94a3b8',
          }}
        >
          🔍
        </span>
        {stationQuery && (
          <button
            type="button"
            onClick={() => setStationQuery('')}
            style={{
              position: 'absolute',
              right: '14px',
              top: '50%',
              transform: 'translateY(-50%)',
              background: '#f1f5f9',
              border: 'none',
              borderRadius: '50%',
              width: '24px',
              height: '24px',
              cursor: 'pointer',
              fontSize: '11px',
              color: '#64748b',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Main Layout Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: viewMode === 'map' ? '1fr' : '360px 1fr',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        {/* Left Column: Route List & Individual Buses (Sajha Plus Style) */}
        {viewMode !== 'map' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Route Selector Cards */}
            <div>
              <div style={{ fontSize: '11.5px', fontWeight: '700', textTransform: 'uppercase', color: '#64748b', marginBottom: '8px' }}>
                उपलब्ध मार्गहरू · Active Corridors ({filteredRoutes.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '280px', overflowY: 'auto' }}>
                {filteredRoutes.map((route) => {
                  const isSelected = selectedRouteId === route.id;
                  return (
                    <button
                      key={route.id}
                      type="button"
                      onClick={() => {
                        setSelectedRouteId(route.id);
                        setSelectedBusId(route.buses[0]?.id || null);
                      }}
                      style={{
                        padding: '12px 14px',
                        background: isSelected ? '#fff' : '#f8fafc',
                        border: `2px solid ${isSelected ? 'var(--color-brand, #a8202f)' : '#e2e8f0'}`,
                        borderRadius: '12px',
                        textAlign: 'left',
                        cursor: 'pointer',
                        boxShadow: isSelected ? '0 4px 12px rgba(168, 32, 47, 0.12)' : 'none',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                        <span
                          style={{
                            background: isSelected ? 'var(--color-brand, #a8202f)' : '#e2e8f0',
                            color: isSelected ? '#fff' : '#334155',
                            padding: '2px 8px',
                            borderRadius: '6px',
                            fontSize: '11px',
                            fontWeight: '700',
                          }}
                        >
                          {route.number}
                        </span>
                        <span style={{ fontSize: '11.5px', color: '#16a34a', fontWeight: '700' }}>
                          {route.buses.length} demo buses
                        </span>
                      </div>
                      <div style={{ fontSize: '14px', fontWeight: '700', color: '#0f172a' }}>
                        {route.fromNe} ⇄ {route.toNe}
                      </div>
                      <div style={{ fontSize: '11.5px', color: '#64748b', marginTop: '2px' }}>
                        {route.stops.length} stops · {route.distanceKm} km · रु {route.fareNormal}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Individual Buses Running on Selected Route */}
            {activeRoute && (
              <div>
                <div style={{ fontSize: '11.5px', fontWeight: '700', textTransform: 'uppercase', color: '#64748b', marginBottom: '8px' }}>
                  {activeRoute.number} का बसहरू · Buses in Transit
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {activeRoute.buses.map((bus) => {
                    const isSelected = activeBus?.id === bus.id;
                    const v = VENDORS[bus.vendor] || {};
                    return (
                      <div
                        key={bus.id}
                        onClick={() => setSelectedBusId(bus.id)}
                        style={{
                          background: isSelected ? '#fef2f2' : '#ffffff',
                          border: `1.5px solid ${isSelected ? 'var(--color-brand, #a8202f)' : '#e2e8f0'}`,
                          borderRadius: '12px',
                          padding: '12px',
                          cursor: 'pointer',
                          boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ fontSize: '13px', fontWeight: '800', color: '#0f172a' }}>
                              {bus.plateStr}
                            </span>
                            <span
                              style={{
                                background: v.badgeBg || '#fee2e2',
                                color: v.color || '#a8202f',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                fontSize: '10px',
                                fontWeight: '700',
                              }}
                            >
                              {v.name}
                            </span>
                          </div>
                          <span style={{ fontSize: '11px', fontWeight: '700', color: '#475569' }}>
                            {bus.speedKmh} km/h
                          </span>
                        </div>

                        <div style={{ fontSize: '12px', color: '#475569', marginBottom: '4px' }}>
                          Current: <strong>{bus.currentStop?.name || 'In Transit'}</strong>
                        </div>
                        <div style={{ fontSize: '12px', color: '#a8202f', fontWeight: '600', marginBottom: '6px' }}>
                          Next: <strong>{bus.nextStop?.name || 'Next Station'}</strong> · ETA {bus.etaMinutes}m
                        </div>

                        {/* Available Seats Pill */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px' }}>
                          <span style={{ color: bus.crowdColor, fontWeight: '700' }}>
                            ● {bus.crowdNe || `${bus.availableSeats} Seats Open`}
                          </span>
                          <span style={{ color: '#94a3b8' }}>{bus.occupiedSeats}/{bus.capacity} seats</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Right Column: OpenStreetMap and Detailed Bus Telemetry Card */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <OsmFleetMap
            buses={snapshot.allBuses}
            routes={snapshot.routes}
            selectedRouteId={selectedRouteId}
            selectedBusId={selectedBusId}
            onSelectBus={(bus) => {
              setSelectedBusId(bus.id);
              setSelectedRouteId(bus.routeId);
            }}
            onSelectRoute={(routeId) => setSelectedRouteId(routeId)}
            height={viewMode === 'map' ? '680px' : '480px'}
          />

          {/* Active Bus Telemetry Card */}
          {activeBus && (
            <LiveBusStatusCard
              bus={activeBus}
              onClose={() => setSelectedBusId(null)}
              showDetailed={true}
            />
          )}
        </div>
      </div>
    </div>
  );
}
