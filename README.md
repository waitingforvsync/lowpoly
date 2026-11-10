# Lowpoly

A minimalist, browser-based low-poly mesh editor.

**Live:** https://waitingforvsync.github.io/lowpoly/ (deployed from `main` on every push).

- [PLAN.md](PLAN.md): design and roadmap
- [CODE.md](CODE.md): code structure, classes and APIs
- [JOURNAL.md](JOURNAL.md): engineering decisions and mistakes along the way

```sh
npm install
npm run dev        # dev server
npm test           # unit tests (vitest)
npm run typecheck
npm run build      # static site in dist/ (relative base, host anywhere)
```

Navigation: middle-drag orbits, Shift+middle or right-drag pans, the wheel zooms to the cursor.
