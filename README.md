# speedtest

This repository contains a Vite + React single-page application configured for deployment on GitHub Pages.

## Getting started

```bash
npm install
npm run dev
```

The development server will be available at <http://localhost:5173/> by default.

## Building for production

```bash
npm run build
```

The build output is written to the `dist/` directory.

## Deploying to GitHub Pages

The project uses the [`gh-pages`](https://github.com/tschaub/gh-pages) package to publish the production build to the `gh-pages` branch.

```bash
npm run deploy
```

Before deploying, ensure the repository is hosted at `https://<username>.github.io/speedtest/` so the configured Vite base path works correctly.
