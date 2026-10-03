// Crew build entry. The bus unit's own database, apart from any rider wallet
// on the same phone. Fares, legs and the door tape collected before the split
// are carried over once, so nothing waiting to sync is stranded.
import '../../styles/app.css';
import '../../styles/surfaces.css';
import '../../styles/site-app.css';
import '../../styles/meter.css';
import { boot } from '../boot';
import { useRoute } from '../../lib/router';
import { resolveSurface } from '../../lib/surface.mjs';
import { carryOverFromShared } from '../../storage/carry-over';
import BusLoader from '../../components/BusLoader';
import CrewApp from './CrewApp';

function Root() {
  const [path, crossing] = useRoute();
  return (
    <>
      <CrewApp page={resolveSurface(path).page} />
      {crossing ? <BusLoader /> : null}
    </>
  );
}

boot(Root, { database: 'bhada-crew', before: () => carryOverFromShared('bhada') });
