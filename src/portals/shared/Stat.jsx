// A figure with its label, big enough to read across a desk.
export default function Stat({ label, sub, value, prefix, accent, warn }) {
  const tone = accent ? ' op-stat--accent' : warn ? ' op-stat--warn' : '';
  return (
    <div className={`op-stat${tone}`}>
      <dt>
        {label}
        <span>{sub}</span>
      </dt>
      <dd className="tabular">
        {prefix ? <em>{prefix}</em> : null}
        {value}
      </dd>
    </div>
  );
}
