import { Home } from './Home';
import { ListPage } from './ListPage';

export function App() {
  const match = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/);
  if (match?.[1]) {
    return <ListPage shareToken={match[1]} />;
  }
  return <Home />;
}
