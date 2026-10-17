import { names } from '@nx/devkit';

/**
 * The web platform folder of a Flutter app (what `flutter create --platforms web` writes, minus the
 * icons). `flutter build web` refuses to run without web/index.html. The page loads Flutter through
 * flutter_bootstrap.js (Flutter 3.22+) with no inline script, so it works under a strict CSP, and
 * keeps $FLUTTER_BASE_HREF so `--base-href` takes effect.
 */
export function flutterWebFiles(projectName: string): Record<string, string> {
  const title = names(projectName)
    .className.replace(/([A-Z])/g, ' $1')
    .trim();
  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <!-- Replaced by flutter build web --base-href; keep the placeholder. -->
  <base href="$FLUTTER_BASE_HREF">

  <meta charset="UTF-8">
  <meta content="IE=Edge" http-equiv="X-UA-Compatible">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${title}">

  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="apple-mobile-web-app-title" content="${title}">

  <title>${title}</title>
  <link rel="manifest" href="manifest.json">
</head>
<body>
  <script src="flutter_bootstrap.js" async></script>
</body>
</html>
`;
  const manifest = {
    name: title,
    short_name: title,
    start_url: '.',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    description: title,
    orientation: 'portrait-primary',
    prefer_related_applications: false,
    icons: [],
  };
  return {
    'web/index.html': indexHtml,
    'web/manifest.json': JSON.stringify(manifest, null, 2) + '\n',
  };
}
