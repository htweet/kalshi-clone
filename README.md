# Kalshi black-box study and clean-room clone

- `CLONE_SPEC.md`: clean-room specification of kalshi.com, built from observed behavior. Every requirement cites its evidence, and anything unconfirmed is marked UNKNOWN.
- `evidence/`: the captures the spec cites. These are HAR recordings of the public API, the public OpenAPI and AsyncAPI specs, the recovered call-site list, and screenshots.
- `clone/`: **Parlance Exchange**, a functional equivalent built only from the spec. It has its own name, styling and invented data. See `clone/README.md`.

```bash
cd clone && npm install && npm start      # prints the URL (3000, or next free port)
npm run test:e2e                          # 13 end-to-end browser tests
```
