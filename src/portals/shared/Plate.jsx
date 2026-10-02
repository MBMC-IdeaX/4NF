import { plateEn, plateNe } from './plates';

// A plate drawn the way it is painted on the bus, with the Latin spelling a
// token carries underneath.
export default function Plate({ plate, big = false }) {
  return (
    <span className={big ? 'op-plate op-plate--big' : 'op-plate'}>
      <b>{plateNe(plate)}</b>
      <small className="tabular">{plateEn(plate)}</small>
    </span>
  );
}
