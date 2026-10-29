const path = require('path');

const pkg = require(path.join(__dirname, '..', 'package.json'));

module.exports = {
  VERSION: pkg.version,
  PRODUCT: pkg.productName || 'Ethane Launcher',

  // The one game version Ethane is built for, and the Java it needs.
  MC_VERSION: '1.21.11',
  JAVA_MAJOR: 21,

  // Ethane.jar and the Fabric API it was built against are both assets on the "JAR" release.
  // The launcher compares the asset's upload time with the copy it has, so a new jar uploaded
  // to that release reaches everyone on their next launch.
  ETHANE_RELEASE_API: 'https://api.github.com/repos/EthaneClient/Ethane/releases/tags/JAR',
  ETHANE_JAR_URL: 'https://github.com/EthaneClient/Ethane/releases/download/JAR/Ethane.jar',
  // Used only when the release can't be read (GitHub rate limit, outage) and Fabric API is missing.
  FABRIC_API_FALLBACK_URL:
    'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.141.3+1.21.11/fabric-api-0.141.3+1.21.11.jar',

  // New launcher builds are published as releases of this repo.
  LAUNCHER_RELEASES_API: 'https://api.github.com/repos/EthaneClient/EthaneLauncher/releases/latest',

  SITE_URL: 'https://ethaneclient.github.io',
  GITHUB_URL: 'https://github.com/EthaneClient/Ethane',
  DISCORD_URL: 'https://discord.gg/6E9KE2T8PY',
};
