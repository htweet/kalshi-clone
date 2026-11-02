# Kalshi black-box study and clean-room clone

- `CLONE_SPEC.md`: clean-room specification of kalshi.com, built from observed behavior. Every requirement cites its evidence, and anything unconfirmed is marked UNKNOWN. **§13 covers the live site as of 2026-11-02** (from a browser HAR); §1–12 describe the February 2026 build.
- `evidence/`: the captures the spec cites. These are HAR recordings of the public API and of the live site (`web_live_2026-11-02.har`, sanitized), the public OpenAPI and AsyncAPI specs, the recovered call-site list, and screenshots.
- `clone/`: **Parlance Exchange**, a functional equivalent built only from the spec. It has its own name, styling and invented data. See `clone/README.md`.

```bash
cd clone && npm install && npm start      # prints the URL (3000, or next free port)
npm run test:e2e                          # 21 end-to-end browser tests
```
