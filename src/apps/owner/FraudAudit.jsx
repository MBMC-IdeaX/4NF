// Owner portal — fraud audit, as a DEMO on sample rows.
//
// Nothing here reads the database. It shows the shape of the audit an owner
// would get; the page says so at the top, and Today links to it as a demo.

import { useState } from 'react';
import { Icon, Button, Plate, Note, DemoTag } from '../../ui';

const SAMPLE_AUDIT_LOGS = [
  {
    id: 'AUD-9021',
    time: '12:45 PM',
    plate: 'बा २ ख ५६४५',
    vendor: 'मयुर यातायात (demo)',
    type: 'REPLAY_ATTEMPT_BLOCKED',
    actor: 'यात्रु (Passenger)',
    severity: 'high',
    title: 'दोहोरो ट्याप अस्वीकृत (Duplicate Tap-In Blocked)',
    detail: 'सार्वजनिक कुञ्जी P_8f2a... बसमा यात्रा गरिरहेको बेला पुनः ट्याप-इन गर्न खोजिएको थियो। भ्यालिडेटरले तुरुन्त रोक्का गर्‍यो।',
    status: 'सुरक्षित (Neutralized)',
  },
  {
    id: 'AUD-9020',
    time: '12:30 PM',
    plate: 'बा ३ ख ८२१९',
    vendor: 'निलो यातायात (demo)',
    type: 'DOOR_RECONCILIATION_PASS',
    actor: 'खलासी (Conductor)',
    severity: 'clean',
    title: 'ढोका काउन्टर अडिट सफल (Door Break-Beam Match)',
    detail: 'भौतिक ढोका सेन्सरले ४२ यात्रु गणना गर्‍यो। दर्ता भएका टिकट (डिजिटल ३६ + नगद ६) = ४२ (१००% मेल)। रु ५० क्लिन ट्रिप बोनस स्वीकृत।',
    status: 'सफल (Clean Shift)',
  },
  {
    id: 'AUD-9019',
    time: '11:15 AM',
    plate: 'बा ५ ख ९०१२',
    vendor: 'रातो यातायात (demo)',
    type: 'DOPPLER_SPEED_VERIFIED',
    actor: 'सञ्चालक (Operator)',
    severity: 'clean',
    title: 'डपलर गति तथा रुट प्रमाणीकरण',
    detail: 'लगनखेल–रत्नपार्क खण्डमा औसत गति २२ किमी/घण्टा। कुनै पनि जीपीएस छेडछाड वा सिमुलेटेड जम्प फेला परेन।',
    status: 'प्रमाणित (Verified)',
  },
  {
    id: 'AUD-9018',
    time: '10:04 AM',
    plate: 'बा १ ख ३३४४',
    vendor: 'पहेँलो यातायात (demo)',
    type: 'TAMPER_WATCHDOG_CLEAR',
    actor: 'खलासी (Conductor)',
    severity: 'clean',
    title: 'पावर वाचडग सुरक्षित (Supercapacitor Watchdog)',
    detail: '१२V मुख्य ब्याट्री फिड अविच्छिन्न। गाडी गुडिरहेको अवस्थामा कुनै पनि पावर कट भेटिएन।',
    status: 'सक्रिय (Armed)',
  },
  {
    id: 'AUD-9017',
    time: '09:30 AM',
    plate: 'बा २ ख ५६४५',
    vendor: 'मयुर यातायात (demo)',
    type: 'APP_FEE_DEDUCTED',
    actor: 'प्लेटफर्म (Platform)',
    severity: 'info',
    title: 'मासिक एप शुल्क (Monthly app fee)',
    detail: 'Monthly per-bus app fee taken from the owner’s payout under the signed payout mandate. The payment partner moved the money; Bhada recorded it.',
    status: 'फर्छ्यौट (Settled)',
  },
  {
    id: 'AUD-9016',
    time: '08:50 AM',
    plate: 'बा ४ ख ७१२३',
    vendor: 'निलो यातायात (demo)',
    type: 'DEAD_PHONE_CLAIM',
    actor: 'यात्रु (Passenger)',
    severity: 'info',
    title: 'Dead-phone claim (unclosed ride)',
    detail: 'A ride never tapped out was charged the unclosed cap. The passenger’s phone signed its own distance reading; the difference over the ordinary fare was returned, once.',
    status: 'फर्छ्यौट (Settled)',
  },
];

export default function FraudAudit({ go }) {
  const [filter, setFilter] = useState('all');
  const [selectedLog, setSelectedLog] = useState(null);

  const logs = filter === 'all'
    ? SAMPLE_AUDIT_LOGS
    : SAMPLE_AUDIT_LOGS.filter((l) => l.type === filter || (filter === 'threats' && l.severity === 'high'));

  return (
    <div className="bx-pane" style={{ padding: '16px 20px', maxWidth: '1000px', margin: '0 auto' }}>
      <header style={{ marginBottom: '24px' }}>
        <p className="bx-eyebrow" style={{ color: 'var(--bx-accent, #a8202f)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Icon name="shield" /> धोखाधडी रोकथाम तथा टेलिमेट्री अडिट
        </p>
        <h1 className="bx-h1" style={{ margin: '4px 0 8px 0', fontSize: '26px' }}>
          Fraud audit <DemoTag>Sample</DemoTag>
        </h1>
        <p style={{ margin: 0, color: 'var(--bx-ink-2, #6b645b)', fontSize: '14px', lineHeight: 1.5 }}>
          The checks Bhada is designed to run on every bus: replayed codes, power cuts while moving, door counts against records, impossible speeds.
        </p>
        <div style={{ marginTop: 12 }}>
          <Note tone="warn" icon="info">
            <b><DemoTag>Sample data</DemoTag> Nothing on this page is a real event.</b> Every figure and log row is made up to show the
            idea. Replay refusal, power-loss records and the speed gate are built and proven; the door optical counter and the
            supercapacitor watchdog are not built yet.
          </Note>
        </div>
        {go ? <p style={{ marginTop: 8 }}><Button variant="ghost" icon="back" onClick={() => go('')}>Back to Today</Button></p> : null}
      </header>

      {/* KPI Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '14px',
        marginBottom: '24px',
      }}>
        <div style={{
          background: 'var(--bx-surface, #fff)',
          border: '1px solid var(--bx-outline, #e4e1d8)',
          borderRadius: '10px',
          padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '13px', color: 'var(--bx-ink-2, #6b645b)' }}>दोहोरो ट्याप रोक्का</span>
            <span style={{ color: '#1b6b3e' }}><Icon name="shield" /></span>
          </div>
          <p style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 4px 0', color: 'var(--bx-ink, #16130f)' }}>
            १४ प्रयास
          </p>
          <small style={{ color: '#1b6b3e', fontWeight: 600, fontSize: '11px' }}>
            १००% रोक्का (स्क्रिनसट पुनःप्रयोग निष्प्रभावी)
          </small>
        </div>

        <div style={{
          background: 'var(--bx-surface, #fff)',
          border: '1px solid var(--bx-outline, #e4e1d8)',
          borderRadius: '10px',
          padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '13px', color: 'var(--bx-ink-2, #6b645b)' }}>पावर टेम्पर अलर्ट</span>
            <span style={{ color: '#1b6b3e' }}><Icon name="power" /></span>
          </div>
          <p style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 4px 0', color: 'var(--bx-ink, #16130f)' }}>
            ० घटना
          </p>
          <small style={{ color: '#1b6b3e', fontWeight: 600, fontSize: '11px' }}>
            सबै फिड सामान्य (सुपरक्यापेसिटर सक्रिय)
          </small>
        </div>

        <div style={{
          background: 'var(--bx-surface, #fff)',
          border: '1px solid var(--bx-outline, #e4e1d8)',
          borderRadius: '10px',
          padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '13px', color: 'var(--bx-ink-2, #6b645b)' }}>ढोका काउन्टर मेल</span>
            <span style={{ color: '#1b6b3e' }}><Icon name="door" /></span>
          </div>
          <p style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 4px 0', color: 'var(--bx-ink, #16130f)' }}>
            ९७.२%
          </p>
          <small style={{ color: '#1b6b3e', fontWeight: 600, fontSize: '11px' }}>
            ९०% थ्रेसहोल्ड भन्दा माथि (बोनस योग्य)
          </small>
        </div>

        <div style={{
          background: 'var(--bx-surface, #fff)',
          border: '1px solid var(--bx-outline, #e4e1d8)',
          borderRadius: '10px',
          padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '13px', color: 'var(--bx-ink-2, #6b645b)' }}>डपलर गति विश्वसनीयता</span>
            <span style={{ color: '#1b6b3e' }}><Icon name="route" /></span>
          </div>
          <p style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 4px 0', color: 'var(--bx-ink, #16130f)' }}>
            १००%
          </p>
          <small style={{ color: '#1b6b3e', fontWeight: 600, fontSize: '11px' }}>
            भौतिक गति सीमा (&lt; ७९ किमी/घण्टा) भित्र
          </small>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '4px' }}>
        {[
          { id: 'all', label: 'सबै लगहरू (All)' },
          { id: 'threats', label: '⚠️ रोक्का गरिएका प्रयासहरू (Blocked)' },
          { id: 'DOOR_RECONCILIATION_PASS', label: '🚪 ढोका काउन्टर (Door Break-Beam)' },
          { id: 'TAMPER_WATCHDOG_CLEAR', label: '⚡ पावर वाचडग (Power)' },
          { id: 'APP_FEE_DEDUCTED', label: '💼 App fee' },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            style={{
              padding: '6px 14px',
              borderRadius: '20px',
              border: '1px solid',
              borderColor: filter === f.id ? 'var(--bx-accent, #a8202f)' : 'var(--bx-outline, #e4e1d8)',
              background: filter === f.id ? 'var(--bx-accent, #a8202f)' : 'var(--bx-surface, #fff)',
              color: filter === f.id ? '#fff' : 'var(--bx-ink-2, #6b645b)',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Audit Log Table */}
      <div style={{
        background: 'var(--bx-surface, #fff)',
        border: '1px solid var(--bx-outline, #e4e1d8)',
        borderRadius: '12px',
        overflow: 'hidden',
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--bx-surface-2, #f6f4ee)', borderBottom: '1px solid var(--bx-outline, #e4e1d8)', color: 'var(--bx-ink-2, #6b645b)' }}>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>समय</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>बस नम्बर</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>संस्था / भेन्डर</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>पक्ष (Actor)</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>घटना विवरण</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>अवस्था (Status)</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.id}
                  onClick={() => setSelectedLog(log)}
                  style={{
                    borderBottom: '1px solid var(--bx-outline, #e4e1d8)',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bx-surface-2, #fbfaf7)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', color: 'var(--bx-ink-2, #6b645b)' }}>
                    {log.time}
                  </td>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                    <Plate plate={log.plate} />
                  </td>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', fontWeight: 500 }}>
                    {log.vendor}
                  </td>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', fontSize: '12px', color: 'var(--bx-ink-2, #6b645b)' }}>
                    {log.actor}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--bx-ink, #16130f)', marginBottom: '2px' }}>
                      {log.title}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--bx-ink-2, #6b645b)', maxWidth: '400px' }}>
                      {log.detail}
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                    <span style={{
                      padding: '3px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 600,
                      background: log.severity === 'high' ? '#fdf0ed' : log.severity === 'clean' ? '#eef8f2' : '#eef2f9',
                      color: log.severity === 'high' ? '#a8202f' : log.severity === 'clean' ? '#1b6b3e' : '#1d4ed8',
                    }}>
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Log Detail Modal */}
      {selectedLog ? (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(22, 19, 15, 0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '16px',
        }}>
          <div style={{
            background: 'var(--bx-surface, #fff)',
            borderRadius: '12px',
            maxWidth: '520px',
            width: '100%',
            padding: '24px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Plate plate={selectedLog.plate} />
                <span style={{ fontSize: '13px', color: 'var(--bx-ink-2, #6b645b)' }}>{selectedLog.time}</span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedLog(null)}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--bx-ink-2, #6b645b)' }}
              >
                ✕
              </button>
            </div>

            <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', color: 'var(--bx-ink, #16130f)' }}>
              {selectedLog.title}
            </h3>

            <p style={{ margin: '0 0 16px 0', fontSize: '14px', lineHeight: 1.6, color: 'var(--bx-ink-2, #6b645b)' }}>
              {selectedLog.detail}
            </p>

            <div style={{
              background: 'var(--bx-surface-2, #f6f4ee)',
              borderRadius: '8px',
              padding: '12px 14px',
              fontSize: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              marginBottom: '20px',
            }}>
              <div><b>अडिट आईडी (Audit ID):</b> {selectedLog.id}</div>
              <div><b>सञ्चालक (Fleet):</b> {selectedLog.vendor}</div>
              <div><b>प्रणालीगत सुरक्षा (Defense Protocol):</b> Ed25519 In-Flight Key Locking & DS3231 RTC Reference</div>
            </div>

            <Button block variant="primary" onClick={() => setSelectedLog(null)}>
              बन्द गर्नुहोस् (Close)
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
