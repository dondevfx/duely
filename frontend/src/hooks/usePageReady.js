import { useState, useEffect } from 'react';

export function usePageReady(delay = 120) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setReady(true), delay);
    return () => clearTimeout(id);
  }, []);
  return ready;
}
