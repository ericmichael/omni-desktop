import * as React from 'react';

// Stock shadcn Sidebar switches its rendered desktop column at Tailwind's
// `md` breakpoint. This hook must use that same boundary: if it switches at
// `sm` instead, widths between 640px and 767px render neither the mobile
// Sheet nor the `md:block` desktop sidebar.
const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  // Electron never server-renders this tree, so initialize from the real
  // viewport. This prevents one frame of the desktop branch on mobile and
  // lets Sidebar rely on its React branch instead of duplicate CSS hiding.
  const [isMobile, setIsMobile] = React.useState(() => window.innerWidth < MOBILE_BREAKPOINT);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener('change', onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
