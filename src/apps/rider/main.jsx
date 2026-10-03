// Rider build entry. Keeps the database name every passenger phone already
// has, so no wallet, key or receipt moves when this became its own app.
import '../../styles/app.css';
import '../../styles/surfaces.css';
import '../../styles/site-app.css';
import '../../styles/meter.css';
import { boot } from '../boot';
import { useRoute } from '../../lib/router';
import { resolveSurface } from '../../lib/surface.mjs';
import BusLoader from '../../components/BusLoader';
import RiderApp from './RiderApp';

function Root() {
  const [path, crossing] = useRoute();
  return (
    <>
      <RiderApp page={resolveSurface(path).page} />
      {crossing ? <BusLoader /> : null}
    </>
  );
}

boot(Root, { database: 'bhada' });
