// Staff build entry.
import '../../styles/app.css';
import '../../styles/surfaces.css';
import '../../styles/site-app.css';
import { boot } from '../boot';
import { useRoute } from '../../lib/router';
import { resolveSurface } from '../../lib/surface.mjs';
import StaffApp from './StaffApp';

function Root() {
  const [path] = useRoute();
  return <StaffApp page={resolveSurface(path).page} />;
}

boot(Root, { database: 'bhada-staff' });
