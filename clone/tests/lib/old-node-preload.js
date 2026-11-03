'use strict';
// Test-only preload: makes the process report an old Node version so the startup guard in server/index.js can be
// exercised without installing an old Node (tests/e2e.test.js "startup on an old Node").
Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '20.11.1' } });
