// Owner build entry.
import '../../styles/app.css';
import '../../styles/surfaces.css';
import '../../styles/site-app.css';
import { boot } from '../boot';
import { useRoute } from '../../lib/router';
import { resolveSurface } from '../../lib/surface.mjs';
import BusLoader from '../../components/BusLoader';
import OwnerApp from './OwnerApp';

function Root() {
  const [path, crossing] = useRoute();
  return (
    <>
      <OwnerApp page={resolveSurface(path).page} />
      {crossing ? <BusLoader /> : null}
    </>
  );
}

boot(Root, { database: 'bhada-owner' });
