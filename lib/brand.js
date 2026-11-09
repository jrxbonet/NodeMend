'use strict';
const NAME = 'NodeMend';
const PUBLISHER = 'Namer-Lavan';
// The full build is simply "NodeMend". "Solo" is the smaller build without enterprise/.
const EDITIONS = { solo: NAME + ' Solo', enterprise: NAME };
// The app only ever links to the project page. Donation and source-code destinations are
// chosen there, so they can change without shipping a new build.
const HOME = 'https://namer-lavan.com/downloads/nodemend';
const LINKS = { home: HOME, support: HOME + '#support', source: HOME + '#source' };

// Keep the existing internal protocols and license module contract. New public
// environment names take precedence, while every legacy variable still works.
function applyEnvironmentAliases(env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODEMEND_')) env['TIDYWIN_' + key.slice(9)] = env[key];
  }
  return env;
}

module.exports = { NAME, PUBLISHER, EDITIONS, LINKS, applyEnvironmentAliases };
