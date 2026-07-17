<<<<<<< HEAD
# run

node server.js 

wasm-pack build --target web --out-dir ../pkg --dev
=======
# iKlippa Frontend

## Running locally

First, install dependencies:
```bash
npm install
```

Then start the Vite development server:
```bash
npm run dev
```

## Running tests

```bash
npm test
```

## Rebuilding WASM

If you make changes to the Rust engine:
```bash
cd rust-engine
wasm-pack build --target web --out-dir ../public/pkg --dev
```
>>>>>>> refs/rewritten/merge-sync-frontend-changes-from-teammate
