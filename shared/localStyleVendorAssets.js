'use strict';

const path = require('node:path');

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const SPACE_GROTESK_FILES = Object.freeze([
  'space-grotesk-vietnamese-wght-normal.woff2',
  'space-grotesk-latin-ext-wght-normal.woff2',
  'space-grotesk-latin-wght-normal.woff2',
]);

const IBM_PLEX_MONO_FILES = Object.freeze(
  [400, 600].flatMap((weight) => [
    'cyrillic-ext',
    'cyrillic',
    'vietnamese',
    'latin-ext',
    'latin',
  ].map((subset) => `ibm-plex-mono-${subset}-${weight}-normal.woff2`))
);

const FONT_AWESOME_FILES = Object.freeze([
  'fa-brands-400.ttf',
  'fa-brands-400.woff2',
  'fa-regular-400.ttf',
  'fa-regular-400.woff2',
  'fa-solid-900.ttf',
  'fa-solid-900.woff2',
  'fa-v4compatibility.ttf',
  'fa-v4compatibility.woff2',
]);

function localStyleVendorAssets(nodeModulesRoot) {
  const assets = [
    {
      route: '/vendor/fontawesome/6.4.0/css/all.min.css',
      file: path.join(nodeModulesRoot, '@fortawesome', 'fontawesome-free', 'css', 'all.min.css'),
      contentType: 'text/css',
    },
    ...FONT_AWESOME_FILES.map((file) => ({
      route: `/vendor/fontawesome/6.4.0/webfonts/${file}`,
      file: path.join(nodeModulesRoot, '@fortawesome', 'fontawesome-free', 'webfonts', file),
      contentType: file.endsWith('.woff2') ? 'font/woff2' : 'font/ttf',
    })),
    ...SPACE_GROTESK_FILES.map((file) => ({
      route: `/vendor/fonts/space-grotesk/5.3.0/files/${file}`,
      file: path.join(nodeModulesRoot, '@fontsource-variable', 'space-grotesk', 'files', file),
      contentType: 'font/woff2',
    })),
    ...IBM_PLEX_MONO_FILES.map((file) => ({
      route: `/vendor/fonts/ibm-plex-mono/5.3.0/files/${file}`,
      file: path.join(nodeModulesRoot, '@fontsource', 'ibm-plex-mono', 'files', file),
      contentType: 'font/woff2',
    })),
  ];

  return Object.freeze(assets.map((asset) => Object.freeze(asset)));
}

function registerLocalStyleVendorAssets(app, nodeModulesRoot) {
  for (const asset of localStyleVendorAssets(nodeModulesRoot)) {
    app.get(asset.route, (_req, res) => {
      res.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
      res.type(asset.contentType);
      res.sendFile(asset.file);
    });
  }
}

module.exports = {
  FONT_AWESOME_FILES,
  IBM_PLEX_MONO_FILES,
  IMMUTABLE_CACHE_CONTROL,
  SPACE_GROTESK_FILES,
  localStyleVendorAssets,
  registerLocalStyleVendorAssets,
};
