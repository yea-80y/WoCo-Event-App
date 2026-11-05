// Vite's `?worker&url` import (vite/client declares it for the app; this package
// type-checks on its own, without Vite's client types).
declare module "*?worker&url" {
  const src: string;
  export default src;
}
