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
