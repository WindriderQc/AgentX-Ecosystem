'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('routing rollout flags reach the production Core process', () => {
  test.each(['ROUTE_RESOLVER_SHADOW', 'DEGRADED_FALLBACK'])(
    '%s is passed through Compose and defaults off',
    (flag) => {
      const compose = read('docker-compose.yml');
      const exampleEnv = read('.env.example');

      expect(compose).toContain(`${flag}=\${${flag}:-false}`);
      expect(exampleEnv).toMatch(new RegExp(`^${flag}=false$`, 'm'));
    }
  );
});
