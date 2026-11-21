// No-op "instrumenter": same plugin shape as the real one, returns sources unchanged.
// `node run.mjs --plugin identity-plugin.mjs` must pass every case.
export default function vtoIdentity() {
  return {
    name: 'vto-identity',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('/node_modules/') || /\.(test|spec)\./.test(id) || id.startsWith('\0')) return null;
      if (!/\.[cm]?[jt]sx?$/.test(id.replace(/[?#].*$/, ''))) return null;
      return { code, map: null };
    },
  };
}
