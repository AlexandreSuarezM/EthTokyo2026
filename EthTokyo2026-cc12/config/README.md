# config

Deployed addresses, one JSON file per chain: `<chainId>.json` (Sepolia: `11155111.json`).
Written by `contracts/script/Deploy.s.sol` and read by the app. Addresses only: never put keys or RPC secrets here.

- `<chainId>.json` is written on `--broadcast` and is committed.
- `<chainId>.dry-run.json` (simulations) and `31337.json` (local anvil) are git-ignored.
