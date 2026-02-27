const esbuild = require('esbuild');
const path = require('path');

const projectRoot = __dirname;
const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

const commonOptions = {
  bundle: true,
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: 'info',
  absWorkingDir: projectRoot,
};

async function main() {
  const extensionBuild = {
    ...commonOptions,
    entryPoints: [path.join(projectRoot, 'src/extension.ts')],
    outfile: path.join(projectRoot, 'dist/extension.js'),
    format: 'cjs',
    platform: 'node',
    external: ['vscode'],
  };

  const webviewBuild = {
    ...commonOptions,
    entryPoints: [path.join(projectRoot, 'src/webview/index.ts')],
    outfile: path.join(projectRoot, 'dist/webview.js'),
    format: 'iife',
    platform: 'browser',
  };

  if (isWatch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extensionBuild),
      esbuild.context(webviewBuild),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionBuild),
      esbuild.build(webviewBuild),
    ]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
