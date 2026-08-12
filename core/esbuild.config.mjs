import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: [
    'src/frontend/shared-utils.js',
    'src/frontend/shared-tokens.css',
  ],
  bundle: true,
  external: ['/js/*'],
  outdir: 'public/dist',
  format: 'esm',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: true,
});
