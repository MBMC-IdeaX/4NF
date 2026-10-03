import { useState, useEffect, useMemo } from 'react';
import OsmFleetMap from '../../ui/OsmFleetMap';
import LiveBusStatusCard from '../../ui/LiveBusStatusCard';
import { fleetEngine } from '../../lib/fleet-simulator';
import { VENDORS } from '../../data/valley-routes';

export default function OwnerFleetMap({ go }) {
  const [snapshot, setSnapshot] = useState(() => fleetEngine.getSnapshot());
  const [selectedVendor, setSelectedVendor] = useState('all');
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [selectedBusId, setSelectedBusId] = useState(null);

  // Subscribe to live simulated fleet motion
  useEffect(() => {
    return fleetEngine.subscribe(setSnapshot);
  }, []);

  // Filter buses by vendor if selected
  const filteredBuses = useMemo(() => {
    if (selectedVendor === 'all') return snapshot.allBuses;
    return snapshot.allBuses.filter((b) => b.vendor === selectedVendor);
  }, [snapshot.allBuses, selectedVendor]);

  // Selected bus object
  const activeBus = useMemo(() => {
    if (!selectedBusId) return null;
    return snapshot.allBuses.find((b) => b.id === selectedBusId) || null;
  }, [snapshot.allBuses, selectedBusId]);

  // Aggregate telemetry stats
  const totalOccupied = snapshot.allBuses.reduce((acc, b) => acc + (b.occupiedSeats || 0), 0);
  const totalCapacity = snapshot.allBuses.reduce((acc, b) => acc + (b.capacity || 42), 0);
  const movingCount = snapshot.allBuses.filter((b) => b.speedKmh > 0).length;
  const avgSpeed = Math.round(
    snapshot.allBuses.reduce((acc, b) => acc + (b.speedKmh || 0), 0) / (snapshot.allBuses.length || 1)
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', fontFamily: 'var(--font-body, system-ui)' }}>
      {/* Top Header & Fleet KPI Counters */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
        <div>
          <p className="bx-eyebrow" style={{ color: 'var(--color-brand, #a8202f)', margin: 0, fontWeight: '700' }}>
            लाइभ ट्र्याकिङ · Live OpenStreetMap Fleet Telemetry
          </p>
          <h1 style={{ fontSize: '28px', fontWeight: '800', margin: '4px 0 0', color: '#16130f' }}>
            {snapshot.totalBuses} सक्रिय बसहरू (Active Fleet)
          </h1>
          <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: '13.5px' }}>
            Real-time GNSS simulation across Kathmandu Valley transit corridors
          </p>
        </div>

        {/* Live Metrics Strip */}
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '10px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Moving / In Motion</div>
            <div style={{ fontSize: '20px', fontWeight: '800', color: '#16a34a' }}>{movingCount} / {snapshot.totalBuses}</div>
          </div>
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '10px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Total Riders Aboard</div>
            <div style={{ fontSize: '20px', fontWeight: '800', color: '#0f172a' }}>{totalOccupied} <small style={{ fontSize: '12px', color: '#64748b' }}>/{totalCapacity}</small></div>
          </div>
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '10px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '700', textTransform: 'uppercase' }}>Avg Valley Speed</div>
            <div style={{ fontSize: '20px', fontWeight: '800', color: '#0284c7' }}>{avgSpeed} km/h</div>
          </div>
        </div>
      </div>

      {/* Vendor Filter Buttons */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', fontWeight: '700', color: '#64748b', marginRight: '4px' }}>
          कम्पनी / Vendor:
        </span>
        <button
          type="button"
          onClick={() => setSelectedVendor('all')}
          style={{
            padding: '6px 14px',
            borderRadius: '999px',
            border: `1.5px solid ${selectedVendor === 'all' ? '#16130f' : '#e2e8f0'}`,
            background: selectedVendor === 'all' ? '#16130f' : '#fff',
            color: selectedVendor === 'all' ? '#fff' : '#475569',
            fontSize: '12px',
            fontWeight: '700',
            cursor: 'pointer',
          }}
        >
          सबै ({snapshot.allBuses.length})
        </button>

        {Object.entries(VENDORS).map(([key, v]) => {
          const isSelected = selectedVendor === key;
          const count = snapshot.allBuses.filter((b) => b.vendor === key).length;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedVendor(key)}
              style={{
                padding: '6px 14px',
                borderRadius: '999px',
                border: `1.5px solid ${isSelected ? v.color : '#e2e8f0'}`,
                background: isSelected ? v.color : '#fff',
                color: isSelected ? '#fff' : '#475569',
                fontSize: '12px',
                fontWeight: '700',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: isSelected ? '#fff' : v.color,
                }}
              />
              {v.name} ({count})
            </button>
          );
        })}
      </div>

      {/* Main Map View & Drawer */}
      <div style={{ display: 'grid', gridTemplateColumns: activeBus ? '1fr 360px' : '1fr', gap: '20px' }}>
        <div style={{ position: 'relative' }}>
          <OsmFleetMap
            buses={filteredBuses}
            routes={snapshot.routes}
            selectedRouteId={selectedRouteId}
            selectedBusId={selectedBusId}
            onSelectBus={(bus) => {
              setSelectedBusId(bus.id);
              setSelectedRouteId(bus.routeId);
            }}
            onSelectRoute={(routeId) => setSelectedRouteId(routeId)}
            height="620px"
          />
        </div>

        {/* Selected Bus Inspection Drawer */}
        {activeBus && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: '13px', fontWeight: '700', color: '#64748b' }}>
              छानिएको बस विवरण · Selected Telemetry
            </div>
            <LiveBusStatusCard
              bus={activeBus}
              onClose={() => setSelectedBusId(null)}
              showDetailed={true}
            />

            {/* Quick Action Buttons for Owner */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                type="button"
                onClick={() => go(`buses/${activeBus.plateStr?.replace(/\s+/g, '-') || activeBus.id}`)}
                style={{
                  padding: '10px 14px',
                  background: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  fontSize: '12.5px',
                  fontWeight: '700',
                  color: '#0f172a',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                📋 View Full Bus Profile & Papers
              </button>
              <button
                type="button"
                onClick={() => setSelectedRouteId(activeBus.routeId)}
                style={{
                  padding: '10px 14px',
                  background: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  borderRadius: '10px',
                  fontSize: '12.5px',
                  fontWeight: '700',
                  color: '#0f172a',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                🔍 Focus on Route ({activeBus.routeNumber})
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
