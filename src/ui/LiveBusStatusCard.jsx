import { Plate } from './index';

export default function LiveBusStatusCard({
  bus,
  onClose,
  onBoardPass = () => {},
  showDetailed = true,
}) {
  if (!bus) return null;

  const vInfo = bus.vendorInfo || {};
  const knownOccupancy = Number.isFinite(bus.occupiedSeats) && Number.isFinite(bus.capacity) && bus.capacity > 0;
  const emptySeats = knownOccupancy ? Math.max(0, Math.min(bus.capacity, bus.capacity - bus.occupiedSeats)) : null;
  const isMoving = bus.speedKmh > 0;

  // Crowd indicator badge styles
  const crowdStyles = {
    available: { bg: '#dcfce7', text: '#15803d', border: '#86efac', dot: '#22c55e' },
    few_seats: { bg: '#fef3c7', text: '#b45309', border: '#fcd34d', dot: '#f59e0b' },
    standing: { bg: '#fee2e2', text: '#b91c1c', border: '#fca5a5', dot: '#ef4444' },
  }[bus.crowdLevel] ?? { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1', dot: '#64748b' };

  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '16px',
        padding: '18px',
        boxShadow: '0 12px 30px rgba(0,0,0,0.1)',
        position: 'relative',
        fontFamily: 'var(--font-body, system-ui)',
      }}
    >
      {/* Top Header: Plate & Close */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                background: vInfo.badgeBg || '#fee2e2',
                color: vInfo.color || '#a8202f',
                border: `1px solid ${vInfo.badgeBorder || '#fca5a5'}`,
                padding: '2px 8px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: '700',
              }}
            >
              {vInfo.name || 'सार्वजनिक बस'}
            </span>
            <span style={{ fontSize: '12px', color: '#64748b', fontWeight: '600' }}>
              {bus.routeNumber || 'Route'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Plate plate={bus.plate || { province: 'बा', number: '२', series: 'ख', digits: '५६४५' }} size="small" />
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                background: isMoving ? '#f0fdf4' : '#fefce8',
                color: isMoving ? '#166534' : '#854d0e',
                border: `1px solid ${isMoving ? '#bbf7d0' : '#fef08a'}`,
                padding: '3px 8px',
                borderRadius: '999px',
                fontSize: '11px',
                fontWeight: '700',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: isMoving ? '#22c55e' : '#eab308',
                }}
              />
              {isMoving ? `${bus.speedKmh} km/h` : 'At Bus Stop'}
            </span>
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{
              background: '#f1f5f9',
              border: 'none',
              borderRadius: '50%',
              width: '28px',
              height: '28px',
              display: 'grid',
              placeItems: 'center',
              cursor: 'pointer',
              color: '#64748b',
              fontSize: '14px',
              fontWeight: '700',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Corridor Endpoints */}
      <div style={{ fontSize: '13.5px', fontWeight: '700', color: '#1e293b', marginBottom: '12px' }}>
        <span>{bus.fromNe || bus.from}</span>
        <span style={{ margin: '0 6px', color: '#94a3b8' }}>⇄</span>
        <span>{bus.toNe || bus.to}</span>
      </div>

      {/* Stop Progression: Current -> Next */}
      <div
        style={{
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          borderRadius: '12px',
          padding: '12px',
          marginBottom: '14px',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '8px', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: '600' }}>
              हालको स्टप / Current
            </div>
            <div style={{ fontSize: '13.5px', fontWeight: '700', color: '#0f172a' }}>
              {bus.currentStop?.ne || bus.currentStop?.name || 'बिसौनी'}
            </div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>{bus.currentStop?.name}</div>
          </div>

          <div style={{ textAlign: 'center', color: '#a8202f', fontWeight: '700', fontSize: '18px' }}>
            →
          </div>

          <div>
            <div style={{ fontSize: '11px', color: '#a8202f', textTransform: 'uppercase', fontWeight: '700' }}>
              अर्को स्टप / Next Stop
            </div>
            <div style={{ fontSize: '13.5px', fontWeight: '700', color: '#0f172a' }}>
              {bus.nextStop?.ne || bus.nextStop?.name || 'आउँदै गरेको'}
            </div>
            <div style={{ fontSize: '11px', color: '#16a34a', fontWeight: '700' }}>
              {bus.etaMinutes <= 1 ? 'Less than a minute' : `ETA: ~${bus.etaMinutes} mins`}
              {bus.distToNextKm !== undefined && ` (${bus.distToNextKm} km)`}
            </div>
          </div>
        </div>
      </div>

      {/* Seat Availability & Crowding Meter */}
      <div style={{ marginBottom: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
          <span style={{ fontSize: '12px', fontWeight: '700', color: '#475569' }}>
            सिट स्थिति / Seat Availability
          </span>
          <span
            style={{
              background: crowdStyles.bg,
              color: crowdStyles.text,
              border: `1px solid ${crowdStyles.border}`,
              padding: '2px 8px',
              borderRadius: '6px',
              fontSize: '11.5px',
              fontWeight: '700',
            }}
          >
            {knownOccupancy ? `${emptySeats} empty seats (simulated)` : 'Occupancy unknown'}
          </span>
        </div>

        {/* Occupancy bar */}
        <div style={{ height: '8px', background: '#e2e8f0', borderRadius: '999px', overflow: 'hidden' }}>
          <div
            style={{
              width: `${knownOccupancy ? Math.max(0, Math.min(100, Math.round((bus.occupiedSeats / bus.capacity) * 100))) : 0}%`,
              height: '100%',
              background: crowdStyles.dot,
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#64748b', marginTop: '4px' }}>
          <span>{knownOccupancy ? bus.occupiedSeats : 'Unknown'} passengers aboard</span>
          <span>Seated places: {bus.capacity ?? 'Unknown'}</span>
        </div>
      </div>

      <p style={{ fontSize: 12 }}>Direction: {bus.direction ?? 'Unknown'} - Updated: {bus.updatedAt ? new Date(bus.updatedAt).toLocaleTimeString() : 'Unknown'}<br />Permitted total capacity: {bus.permittedCapacity ?? 'Unknown'} - Standing: {knownOccupancy ? Math.max(0, bus.occupiedSeats - bus.capacity) : 'Unknown'} (simulated)</p>
      {/* Crew Info & Action Footer */}
      {showDetailed && (
        <div
          style={{
            borderTop: '1px dashed #e2e8f0',
            paddingTop: '12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: '11.5px', color: '#64748b' }}>
            <div>खलासी: <strong style={{ color: '#1e293b' }}>{bus.conductor || 'सिट प्रमाणीकरण'}</strong></div>
            <div>चालक: <strong style={{ color: '#1e293b' }}>{bus.driver || 'चालक'}</strong></div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '10.5px', color: '#64748b' }}>नियमित भाडा (Standard)</div>
            <div style={{ fontSize: '16px', fontWeight: '800', color: '#a8202f' }}>
              रु {bus.fareNormal || 24}
              <small style={{ fontSize: '11px', fontWeight: '600', color: '#64748b', marginLeft: '4px' }}>
                (विद्यार्थी रु {bus.fareStudent || 13})
              </small>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
