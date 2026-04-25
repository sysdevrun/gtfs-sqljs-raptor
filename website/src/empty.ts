// Empty module — used as a Vite alias target for Node-only deps that
// raptor-journey-planner pulls in via re-export but that we never actually
// invoke (e.g. gtfs-stream).
export const plain = () => {
  throw new Error('gtfs-stream is not available in the browser build');
};
export default {};
