// tools/scripts/build.js: one entry point for every app build.
const BASE_HREF = {
  portal: { uat: '/portal/', prod: '/portal/' },
};
const CONFIGS = { dev: 'development', uat: 'uat', prod: 'production' };
module.exports = { BASE_HREF, CONFIGS };
