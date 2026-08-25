// Netlify entry point. The implementation lives in the api workspace so that it is
// typechecked, linted and tested with the rest of the backend; this file only points
// at the compiled output.
export { handler } from '../../apps/api/dist/netlify.js';
