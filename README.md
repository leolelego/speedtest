# speedtest

> A Speed test application for remote worker in there home, coffee shop or van


This repository contains a Vite + React single-page application configured for deployment on GitHub Pages.

## Code Methology
This project is also a way to learn how to use tool like ChatGPT Canevas or OpenAI Codex. 

## Getting started

This repository contains a Vite + React single-page application configured for deployment on GitHub Pages.

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

## Configuration

### Upload endpoint rotation

The upload test now rotates across multiple public endpoints to avoid quota errors. By default it will try:

1. `https://speed.cloudflare.com/__up`
2. `https://postman-echo.com/post`
3. `https://httpbin.org/post`

If every public endpoint fails or you prefer to use your own infrastructure, you can supply one or more custom URLs with the `VITE_UPLOAD_ENDPOINTS` environment variable (a comma-separated list). For example, create a `.env.local` file at the project root:

```bash
VITE_UPLOAD_ENDPOINTS=https://example.com/upload-endpoint
```

Custom endpoints are tried before the built-in fallbacks.
